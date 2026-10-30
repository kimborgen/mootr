package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
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
	go func() {
		done <- serve(ctx, endLife, sse.New(sse.Keepalive), []*http.Server{srv}, func(s *http.Server) error { return s.Serve(ln) }, drain)
	}()
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

// TestBindBeforeBound: bound (the home's boot push) runs once every listener is bound and before any serves, so a
// peer's fetch back made from it waits in the backlog and is answered once serve runs, rather than refused (S-4371).
func TestBindBeforeBound(t *testing.T) {
	srv := &http.Server{Addr: "127.0.0.1:0", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})}
	fetched := make(chan error, 1)
	listen, err := bind([]*http.Server{srv}, func(addrs []net.Addr) {
		if len(addrs) != 1 {
			t.Fatalf("addrs %v", addrs)
		}
		// The connection is made here, before serve: only a bound listener takes it.
		conn, err := net.Dial("tcp", addrs[0].String())
		if err != nil {
			t.Fatalf("dial before serve: %v", err)
		}
		go func() {
			defer conn.Close()
			if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")); err != nil {
				fetched <- err
				return
			}
			buf := make([]byte, 64)
			n, err := conn.Read(buf)
			if err == nil && !strings.HasPrefix(string(buf[:n]), "HTTP/1.1 204") {
				err = fmt.Errorf("answer %q", buf[:n])
			}
			fetched <- err
		}()
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, func() {}, sse.New(sse.Keepalive), []*http.Server{srv}, listen, func(context.Context) error { return nil })
	}()
	if err := <-fetched; err != nil {
		t.Fatal(err)
	}
	stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// TestBindFails: a bind that fails returns its error without running bound.
func TestBindFails(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	ran := false
	if _, err := bind([]*http.Server{{Addr: "127.0.0.1:0"}, {Addr: taken.Addr().String()}}, func([]net.Addr) { ran = true }); err == nil || ran {
		t.Fatalf("bind = %v, bound ran %v", err, ran)
	}
}
