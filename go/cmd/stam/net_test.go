package main

import "net"

func newListener() (net.Listener, error)         { return net.Listen("tcp", "127.0.0.1:0") }
func listenOn(addr string) (net.Listener, error) { return net.Listen("tcp", addr) }
