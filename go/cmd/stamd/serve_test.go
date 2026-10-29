package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"

	"stam/internal/sse"
)

// TestServeListenerFails: when one server stops serving, the lifecycle ends before the shutdown, so a handler that
// runs until it does (an agent's push stream) ends and serve returns the failure at once, not after stopWait.
func TestServeListenerFails(t *testing.T) {
	lifeCtx, endLife := context.WithCancel(context.Background())
	t.Cleanup(endLife)
	entered := make(chan struct{})
	stream := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		http.NewResponseController(w).Flush()
		close(entered)
		<-lifeCtx.Done()
	})}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	failing := &http.Server{}
	failed := errors.New("listen failed")
	listen := func(srv *http.Server) error {
		if srv == failing {
			<-entered
			return failed
		}
		return srv.Serve(ln)
	}
	done := make(chan error, 1)
	go func() {
		done <- serve(context.Background(), endLife, sse.New(sse.Keepalive), []*http.Server{stream, failing}, listen, func(context.Context) error { return nil })
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+ln.Addr().String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	select {
	case err := <-done:
		if !errors.Is(err, failed) {
			t.Fatalf("serve = %v", err)
		}
	case <-time.After(stopWait / 2):
		t.Fatal("serve waited on the stream: the lifecycle didn't end before the shutdown")
	}
	if lifeCtx.Err() == nil {
		t.Error("the lifecycle still runs")
	}
}

// TestServeDrainsTerminals: Shutdown doesn't wait for a hijacked connection (a terminal socket), so serve waits for
// drain, after the lifecycle ended (which ends the sockets) and after Shutdown, and returns only once it has.
func TestServeDrainsTerminals(t *testing.T) {
	lifeCtx, endLife := context.WithCancel(context.Background())
	t.Cleanup(endLife)
	ctx, stop := context.WithCancel(context.Background())
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{}
	inDrain, release := make(chan error, 1), make(chan struct{})
	drain := func(shutdown context.Context) error {
		inDrain <- lifeCtx.Err()
		<-release
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- serve(ctx, endLife, sse.New(sse.Keepalive), []*http.Server{srv}, func(s *http.Server) error { return s.Serve(ln) }, drain) }()
	stop()
	select {
	case err := <-inDrain:
		if err == nil {
			t.Fatal("drain ran before the lifecycle ended")
		}
	case err := <-done:
		t.Fatalf("serve returned without the drain: %v", err)
	}
	select {
	case err := <-done:
		t.Fatalf("serve returned before the drain did: %v", err)
	default:
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
