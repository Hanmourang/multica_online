package daemon

import (
	"context"
	"sync"
	"testing"
	"time"
)

// 同模块同组（同 root_requirement_id）之间永不互斥
//（spec 2026-09-04-requirement-calendar-design.md §7.5②）：组内并行
// 研发子任务的执行顺序由依赖 DAG 表达，模块锁只管跨组/跨模块。
func TestModuleLocker_SameModuleNeverBlocks(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", true, nil) // 勾选方
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	// 同组再来一个（无论是否勾选）都应立即成功
	rel2, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t2", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel2()
}

func TestModuleLocker_ExclusiveBlocksOtherModules(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	// 异模块未勾选方被勾选方挡住
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var blocker string
	waited := false
	_, err = l.Acquire(ctx, "m2", "Flow", "r2", "需求B", "t2", false, func(holderModule, holderRoot string) {
		waited = true
		blocker = holderModule
	})
	if err == nil {
		t.Fatal("expected ctx deadline")
	}
	if !waited {
		t.Fatal("onWait not fired")
	}
	if blocker != "内核" {
		t.Fatalf("onWait holder = %q, want %q", blocker, "内核")
	}
}

func TestModuleLocker_SharedDoesNotBlockShared(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	// 异模块未勾选方：另一个未勾选方不构成阻塞
	rel2, err := l.Acquire(context.Background(), "m2", "Flow", "r2", "需求B", "t2", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel2()
}

// 勾选方（排他）必须等异模块的共享持有全部归零才放行。
func TestModuleLocker_ExclusiveWaitsForSharedDrain(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan struct{})
	go func() {
		rel2, err := l.Acquire(context.Background(), "m2", "Flow", "r2", "需求B", "t2", true, nil)
		if err == nil {
			rel2()
			close(acquired)
		}
	}()
	select {
	case <-acquired:
		t.Fatal("exclusive acquired while another module still active")
	case <-time.After(50 * time.Millisecond):
	}
	rel1() // 异模块归零后放行
	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("exclusive not released after drain")
	}
}

// release 幂等：重复调用不 panic、不扩大放行范围。
func TestModuleLocker_ReleaseIsIdempotent(t *testing.T) {
	l := NewModuleLocker()
	rel, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	rel()
	rel() // 第二次不应 panic

	// 释放后异模块勾选方能立即获取
	rel2, err := l.Acquire(context.Background(), "m2", "Flow", "r2", "需求B", "t2", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	rel2()
}

// ctx 取消发生在等待中途：返回 ctx.Err() 且不持有锁（后续其他模块不受影响）。
func TestModuleLocker_CancelMidWaitReleasesNothing(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, err := l.Acquire(ctx, "m2", "Flow", "r2", "需求B", "t2", false, nil)
		if err != context.Canceled {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	}()
	cancel()
	wg.Wait()

	// t2 从未持锁：再来一个异模块任务不应被「幽灵持有」挡住
	ctx2, cancel2 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel2()
	if _, err := l.Acquire(ctx2, "m3", "插件", "r3", "需求C", "t3", false, nil); err == nil {
		t.Fatal("m3 should still block on m1's exclusive hold")
	}
}

// TestModuleLockerGroupMutex 钉死 v2 组语义（spec §7.5②）：锁 key 升级为
// (module_id, root_requirement_id) 后，同模块跨组无条件互斥、同组并发、
// 异模块维持 451 exclusive 语义、root 终态由 ReleaseGroup 整组释放。
func TestModuleLockerGroupMutex(t *testing.T) {
	// 同模块跨组互斥——不看 exclusive（共享/共享也互斥），onWait 注明
	// 持有方需求标题而非模块名。
	t.Run("同模块跨组互斥且注明持有方需求", func(t *testing.T) {
		l := NewModuleLocker()
		rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel1()

		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		var holderModule, holderRoot string
		_, err = l.Acquire(ctx, "m1", "内核", "r2", "需求B", "t2", false, func(m, r string) {
			holderModule, holderRoot = m, r
		})
		if err == nil {
			t.Fatal("cross-group same-module acquire must block")
		}
		if holderModule != "" {
			t.Fatalf("same-module blocker should not report holder module, got %q", holderModule)
		}
		if holderRoot != "需求A" {
			t.Fatalf("onWait holder root = %q, want %q", holderRoot, "需求A")
		}
	})

	// 同模块同组：并行研发子任务互不阻塞（exclusive 也不例外）。
	t.Run("同组并发含勾选方", func(t *testing.T) {
		l := NewModuleLocker()
		rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", true, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel1()
		rel2, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t2", true, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel2()
	})

	// 终态即释放：ReleaseGroup(root) 释放该组全部持有并唤醒同模块
	// 跨组等待方（done/cancelled/failed 均由调用方触发同一 API）。
	t.Run("ReleaseGroup释放整组并唤醒等待方", func(t *testing.T) {
		l := NewModuleLocker()
		rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		rel2, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t2", false, nil)
		if err != nil {
			t.Fatal(err)
		}

		acquired := make(chan func(), 1)
		go func() {
			rel3, err := l.Acquire(context.Background(), "m1", "内核", "r2", "需求B", "t3", false, nil)
			if err == nil {
				acquired <- rel3
			}
		}()
		select {
		case <-acquired:
			t.Fatal("cross-group acquire succeeded while group r1 holds the module")
		case <-time.After(50 * time.Millisecond):
		}

		l.ReleaseGroup("r1")
		select {
		case rel3 := <-acquired:
			rel3()
		case <-time.After(time.Second):
			t.Fatal("waiting group not woken after ReleaseGroup")
		}
		// 组释放后原持有的幂等 release 仍安全（no-op）。
		rel1()
		rel2()
	})

	// 异模块之间不看组：维持 451 的 exclusive 语义——即便同 root，
	// 一方勾选「避免冲突」即互斥。
	t.Run("异模块不看组保持exclusive语义", func(t *testing.T) {
		l := NewModuleLocker()
		rel1, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", true, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel1()

		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		var holderModule string
		_, err = l.Acquire(ctx, "m2", "Flow", "r1", "需求A", "t2", false, func(m, r string) {
			holderModule = m
		})
		if err == nil {
			t.Fatal("cross-module exclusive hold must block even for the same root")
		}
		if holderModule != "内核" {
			t.Fatalf("onWait holder module = %q, want %q", holderModule, "内核")
		}
	})

	// 任一方 root 未知（空 root_requirement_id，如回填前的存量行）时，
	// 同模块维度退化为 451 语义（不互斥），避免老数据被新互斥卡死。
	t.Run("任一方组未知退化为451语义", func(t *testing.T) {
		l := NewModuleLocker()
		rel1, err := l.Acquire(context.Background(), "m1", "内核", "", "", "t1", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel1()
		rel2, err := l.Acquire(context.Background(), "m1", "内核", "r2", "需求B", "t2", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel2()
	})

	// ReleaseGroup 只释放本组持有，其他组的持有不受影响。
	t.Run("ReleaseGroup只释放本组", func(t *testing.T) {
		l := NewModuleLocker()
		// 两个异模块 shared 持有（互不阻塞，可同时持锁）。
		_, err := l.Acquire(context.Background(), "m1", "内核", "r1", "需求A", "t1", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		rel2, err := l.Acquire(context.Background(), "m2", "Flow", "r2", "需求B", "t2", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer rel2()

		l.ReleaseGroup("r1")

		// r1 的持有已释放：同模块跨组任务立即获取成功。
		rel3, err := l.Acquire(context.Background(), "m1", "内核", "r3", "需求C", "t3", false, nil)
		if err != nil {
			t.Fatalf("r1 released by ReleaseGroup, same-module acquire should succeed: %v", err)
		}
		defer rel3()

		// m2 的持有仍在：异模块勾选方应被它挡住。
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		if _, err := l.Acquire(ctx, "m3", "插件", "r4", "需求D", "t4", true, nil); err == nil {
			t.Fatal("m2's hold must survive ReleaseGroup(r1)")
		}
	})
}
