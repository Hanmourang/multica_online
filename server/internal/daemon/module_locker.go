package daemon

import (
	"context"
	"errors"
	"sync"
)

// ModuleLocker 实现「模块 × 需求组」二维互斥
//（spec 2026-09-04-requirement-calendar-design.md §7.5②，451 §5 修订版）。
//
// 锁 key = (moduleID, rootID)。判定规则（判定与计入在同一临界区内完成）：
//
//	同模块同组（rootID 相同且非空）：永不互斥——组内并行子任务的执行
//	  顺序由依赖 DAG 表达
//	同模块跨组：无条件互斥（不看 exclusive）——同模块的不同需求串行，
//	  onWait 注明持有方需求标题
//	异模块：维持 451 语义——任一方 exclusive（avoid_conflict）即互斥，
//	  onWait 注明持有方模块名
//	任一方 rootID 为空（回填前的存量行等）：同模块维度退化为 451
//	  （不互斥），异模块规则不变
//	moduleID 为空：不参与（调用方直接跳过 Acquire）
//
// onWait（上报 waiting_module_lock）在锁外调用一次。不保证严格 FIFO，
// 与 LocalPathLocker 的公平性约定一致；等待队列按 start_at 升序唤醒由
// server 侧 claim 闸门保证，不在本组件职责内。
type ModuleLocker struct {
	mu      sync.Mutex
	cond    *sync.Cond
	holders map[string]moduleHold // taskID → hold
}

type moduleHold struct {
	moduleID   string
	moduleName string
	rootID     string
	rootTitle  string
	exclusive  bool
}

func NewModuleLocker() *ModuleLocker {
	l := &ModuleLocker{
		holders: make(map[string]moduleHold),
	}
	l.cond = sync.NewCond(&l.mu)
	return l
}

// Acquire 以 (moduleID, rootID) 名义为 taskID 取锁；返回幂等 release。
// ctx 取消时返回 ctx.Err() 且未取锁。onWait 在首次判定受阻时于锁外调用一次：
// 异模块阻塞时 holderModule 为持有方模块名（holderRootTitle 为空）；同模块
// 跨组阻塞时 holderRootTitle 为持有方需求标题（holderModule 为空）。
//
// 注：计数等价于 holders 映射的派生量，直接遍历求判定即可——任务量级 ≤
// daemon 并发上限，O(n) 判定足够；显式计数是 spec 的语义表述，实现用
// holders 单事实源避免计数漂移。
func (l *ModuleLocker) Acquire(ctx context.Context, moduleID, moduleName, rootID, rootTitle, taskID string, exclusive bool, onWait func(holderModule, holderRootTitle string)) (func(), error) {
	if moduleID == "" {
		return nil, errors.New("module_locker: moduleID required")
	}
	if taskID == "" {
		return nil, errors.New("module_locker: taskID required")
	}
	// ctx 取消 → Broadcast 唤醒等待循环重查 ctx.Err()。
	stop := context.AfterFunc(ctx, func() {
		l.mu.Lock()
		l.cond.Broadcast()
		l.mu.Unlock()
	})
	defer stop()

	waited := false
	for {
		l.mu.Lock()
		if err := ctx.Err(); err != nil {
			l.mu.Unlock()
			return nil, err
		}
		blocker, blocked := l.blockerLocked(moduleID, rootID, exclusive)
		if !blocked {
			l.holders[taskID] = moduleHold{moduleID: moduleID, moduleName: moduleName, rootID: rootID, rootTitle: rootTitle, exclusive: exclusive}
			l.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { l.release(taskID) }) }, nil
		}
		if !waited {
			waited = true
			if onWait != nil {
				l.mu.Unlock()
				if blocker.moduleID == moduleID {
					onWait("", blocker.rootTitle) // 锁外：可能是一次 HTTP 上报
				} else {
					onWait(blocker.moduleName, "")
				}
				continue
			}
		}
		l.cond.Wait()
		l.mu.Unlock()
	}
}

// blockerLocked 返回挡住本次获取的持有者。规则见类型注释：同模块跨组
// 无条件互斥；异模块维持 451 的 exclusive 语义。
func (l *ModuleLocker) blockerLocked(moduleID, rootID string, exclusive bool) (moduleHold, bool) {
	for _, h := range l.holders {
		if h.moduleID == moduleID {
			// 同模块：组内放行；任一方组未知退化为 451（不互斥）；
			// 跨组无条件互斥。
			if rootID == "" || h.rootID == "" || h.rootID == rootID {
				continue
			}
			return h, true
		}
		// 异模块：维持 451 exclusive 语义。
		if exclusive || h.exclusive {
			return h, true
		}
	}
	return moduleHold{}, false
}

// ReleaseGroup 释放 rootID 需求组中「持有方任务确已不再活跃」的持有，并唤醒
// 全部等待方重查（root 到达终态 done/cancelled/failed 即释放，spec §7.5②）。
// 任务完成时的逐任务 release 是主路径，本 API 兜底「root 终态但持有方任务尚未被
// daemon 回收」的窗口。空 rootID 直接返回。
//
// H-1：isLive 报告某 taskID 是否仍在本 daemon 上运行。ReleaseGroup 只回收
// isLive(taskID)==false 的持有——若 root 需求自身任务先终态就无条件删同组全部
// holders，会误删仍 running 的 stage3/stage4 子任务 hold，Broadcast 唤醒跨组等待方
// 与本组仍运行任务并发写同一模块（推翻 WS3 互斥不变量）。仍活跃的持有被保留，
// 其逐任务 release 由各自 handleTask 完成时触发。isLive 为 nil 视为「全部已终态」
//（释放整组，仅测试与已知整组结束的场景使用）。
//
// 注：本 API 只过滤终态，不改动 blockerLocked 的「同模块跨组互斥」判定语义
//（那是待用户决策项）。
func (l *ModuleLocker) ReleaseGroup(rootID string, isLive func(taskID string) bool) {
	if rootID == "" {
		return
	}
	l.mu.Lock()
	for taskID, h := range l.holders {
		if h.rootID != rootID {
			continue
		}
		if isLive != nil && isLive(taskID) {
			// 持有方任务仍在运行：保留其 hold，避免跨组等待方被误唤醒后与本组并发写。
			continue
		}
		delete(l.holders, taskID)
	}
	l.cond.Broadcast()
	l.mu.Unlock()
}

func (l *ModuleLocker) release(taskID string) {
	l.mu.Lock()
	delete(l.holders, taskID)
	l.cond.Broadcast()
	l.mu.Unlock()
}
