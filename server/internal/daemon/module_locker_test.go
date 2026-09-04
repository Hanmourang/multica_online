package daemon

import (
	"context"
	"sync"
	"testing"
	"time"
)

// 同模块之间永不互斥（spec §5）：同模块的执行顺序由依赖 DAG 表达，
// 模块锁只管跨模块的「避免冲突」。
func TestModuleLocker_SameModuleNeverBlocks(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "t1", true, nil) // 勾选方
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	// 同模块再来一个（无论是否勾选）都应立即成功
	rel2, err := l.Acquire(context.Background(), "m1", "内核", "t2", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel2()
}

func TestModuleLocker_ExclusiveBlocksOtherModules(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	// 异模块未勾选方被勾选方挡住
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var blocker string
	waited := false
	_, err = l.Acquire(ctx, "m2", "Flow", "t2", false, func(holder string) { waited = true; blocker = holder })
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
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()
	// 异模块未勾选方：另一个未勾选方不构成阻塞
	rel2, err := l.Acquire(context.Background(), "m2", "Flow", "t2", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel2()
}

// 勾选方（排他）必须等异模块的共享持有全部归零才放行。
func TestModuleLocker_ExclusiveWaitsForSharedDrain(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "t1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan struct{})
	go func() {
		rel2, err := l.Acquire(context.Background(), "m2", "Flow", "t2", true, nil)
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
	rel, err := l.Acquire(context.Background(), "m1", "内核", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	rel()
	rel() // 第二次不应 panic

	// 释放后异模块勾选方能立即获取
	rel2, err := l.Acquire(context.Background(), "m2", "Flow", "t2", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	rel2()
}

// ctx 取消发生在等待中途：返回 ctx.Err() 且不持有锁（后续其他模块不受影响）。
func TestModuleLocker_CancelMidWaitReleasesNothing(t *testing.T) {
	l := NewModuleLocker()
	rel1, err := l.Acquire(context.Background(), "m1", "内核", "t1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rel1()

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, err := l.Acquire(ctx, "m2", "Flow", "t2", false, nil)
		if err != context.Canceled {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	}()
	cancel()
	wg.Wait()

	// t2 从未持锁：再来一个异模块任务不应被「幽灵持有」挡住
	ctx2, cancel2 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel2()
	if _, err := l.Acquire(ctx2, "m3", "插件", "t3", false, nil); err == nil {
		t.Fatal("m3 should still block on m1's exclusive hold")
	}
}
