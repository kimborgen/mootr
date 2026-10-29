package db

import (
	"context"
	"sync"
)

// writeLock is the writer's queue: a lock handed from one Write to the next in the order they asked. A caller that
// finds it held joins the queue under the same mutex that told it so, so it is counted as waiting from that moment
// (Waiting) and no later caller can take the lock before it.
type writeLock struct {
	mu   sync.Mutex
	held bool
	q    []chan struct{}
}

// lock waits for the lock, or for ctx.
func (l *writeLock) lock(ctx context.Context) error {
	l.mu.Lock()
	if !l.held {
		l.held = true
		l.mu.Unlock()
		return nil
	}
	ch := make(chan struct{})
	l.q = append(l.q, ch)
	l.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		l.mu.Lock()
		for i, c := range l.q {
			if c == ch {
				l.q = append(l.q[:i], l.q[i+1:]...)
				l.mu.Unlock()
				return ctx.Err()
			}
		}
		l.mu.Unlock()
		// The lock was handed to this caller as it gave up: pass it on.
		l.unlock()
		return ctx.Err()
	}
}

// unlock hands the lock to the first caller in the queue, or frees it.
func (l *writeLock) unlock() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.q) == 0 {
		l.held = false
		return
	}
	ch := l.q[0]
	l.q = l.q[1:]
	close(ch)
}

// waiting is how many callers are queued for the lock.
func (l *writeLock) waiting() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.q)
}
