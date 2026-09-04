package daemon

import (
	"context"
	"errors"
	"sync"
)

// ModuleLocker 实现跨模块的「避免冲突」互斥（spec §5）。
//
// 锁模型：每个模块记两组计数 —— total（本模块全部持有数）与
// exclusive（其中勾选「避免冲突」的持有数）。
//
//	勾选方（排他）：等待「异模块 total 全归零」；计入本模块 total+exclusive
//	未勾选方（共享）：等待「异模块 exclusive 全归零」；计入本模块 total
//	同模块之间永不互斥（同模块顺序由依赖 DAG 表达）
//	无模块任务不参与（调用方直接跳过 Acquire）
//
// 由此「一方勾选即锁」双向成立。判定与计入在同一临界区内完成，
// 防止两个异模块勾选方同时判定通过。onWait（上报 waiting_module_lock）
// 在锁外调用，网络上报不阻塞其他任务的获取路径。不保证严格 FIFO，
// 与 LocalPathLocker 的公平性约定一致。
type ModuleLocker struct {
	mu      sync.Mutex
	cond    *sync.Cond
	holders map[string]moduleHold // taskID → hold
}

type moduleHold struct {
	moduleID   string
	moduleName string
	exclusive  bool
}

func NewModuleLocker() *ModuleLocker {
	l := &ModuleLocker{
		holders: make(map[string]moduleHold),
	}
	l.cond = sync.NewCond(&l.mu)
	return l
}

// Acquire 以 moduleID 名义为 taskID 取锁；返回幂等 release。
// ctx 取消时返回 ctx.Err() 且未取锁。onWait 在首次判定受阻时于锁外调用一次，
// 参数是挡住本任务的持有者模块名（可为空字符串表示未知）。
//
// 注：计数等价于 holders 映射的派生量，直接遍历求判定即可——任务量级 ≤
// daemon 并发上限，O(n) 判定足够；显式 total/exclusive 计数是 spec 的语义
// 表述，实现用 holders 单事实源避免计数漂移。
func (l *ModuleLocker) Acquire(ctx context.Context, moduleID, moduleName, taskID string, exclusive bool, onWait func(holderModule string)) (func(), error) {
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
		blocker, blocked := l.blockerLocked(moduleID, exclusive)
		if !blocked {
			l.holders[taskID] = moduleHold{moduleID: moduleID, moduleName: moduleName, exclusive: exclusive}
			l.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { l.release(taskID) }) }, nil
		}
		if !waited {
			waited = true
			if onWait != nil {
				l.mu.Unlock()
				onWait(blocker) // 锁外：可能是一次 HTTP 上报
				continue
			}
		}
		l.cond.Wait()
		l.mu.Unlock()
	}
}

// blockerLocked 返回挡住本次获取的持有者的模块名。
// 规则：异模块持有 ×（本请求排他 或 持有方为排他）⇒ 阻塞。
func (l *ModuleLocker) blockerLocked(moduleID string, exclusive bool) (string, bool) {
	for _, h := range l.holders {
		if h.moduleID == moduleID {
			continue
		}
		if exclusive || h.exclusive {
			return h.moduleName, true
		}
	}
	return "", false
}

func (l *ModuleLocker) release(taskID string) {
	l.mu.Lock()
	delete(l.holders, taskID)
	l.cond.Broadcast()
	l.mu.Unlock()
}
