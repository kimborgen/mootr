package db

import (
	"context"
	"runtime"
	"testing"
)

func spinUntil(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 50_000_000; i++ {
		if ok() {
			return
		}
		runtime.Gosched()
	}
	t.Fatal("condition never held")
}

func TestWriteLockHandsOverInOrder(t *testing.T) {
	var l writeLock
	if err := l.lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	order := make(chan int, 3)
	for i := 0; i < 3; i++ {
		go func() {
			if err := l.lock(context.Background()); err != nil {
				t.Error(err)
			}
			order <- i
			l.unlock()
		}()
		spinUntil(t, func() bool { return l.waiting() == i+1 })
	}
	l.unlock()
	for want := 0; want < 3; want++ {
		if got := <-order; got != want {
			t.Fatalf("grant %d went to caller %d", want, got)
		}
	}
	// Free again once the queue has drained.
	spinUntil(t, func() bool { l.mu.Lock(); defer l.mu.Unlock(); return !l.held })
}

func TestWriteLockCancelledWaiterLeavesTheQueue(t *testing.T) {
	var l writeLock
	if err := l.lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	res := make(chan error, 1)
	go func() { res <- l.lock(ctx) }()
	spinUntil(t, func() bool { return l.waiting() == 1 })
	cancel()
	if err := <-res; err == nil {
		t.Fatal("a cancelled wait got the lock")
	}
	if n := l.waiting(); n != 0 {
		t.Fatalf("%d still queued", n)
	}
	l.unlock()
	if err := l.lock(context.Background()); err != nil {
		t.Fatal(err)
	}
}
