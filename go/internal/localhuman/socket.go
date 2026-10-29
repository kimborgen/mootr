package localhuman

import (
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// loopback is src/daemon.ts LOOPBACK.
var loopback = map[string]bool{"127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true}

// procNetTCP is where the kernel lists TCP sockets with their owners; a test points it elsewhere.
var procNetTCP = []string{"/proc/net/tcp", "/proc/net/tcp6"}

// SocketUID is src/daemon.ts socketUid: the uid that owns the client's end of r's connection, read from the kernel's
// socket table (Linux only). The row must be the client's end exactly: its local address the client's address and
// port, its remote one the daemon's, so a socket another user bound on other addresses with the same ports never
// stands in, and only while connected. ok is false when no row is, or more than one.
func SocketUID(r *http.Request) (uid int, ok bool) {
	client, cport, ok := splitAddr(r.RemoteAddr)
	if !ok {
		return 0, false
	}
	local, _ := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if local == nil {
		return 0, false
	}
	own, oport, ok := splitAddr(local.String())
	if !ok {
		return 0, false
	}
	found := 0
	for i, f := range procNetTCP {
		// The first table is IPv4's; an IPv4 connection on an IPv6 socket is listed in the second, v4-mapped.
		v6 := i == 1
		if !v6 && (client.To4() == nil || own.To4() == nil) {
			continue
		}
		want1, want2 := procAddr(client, cport, v6), procAddr(own, oport, v6)
		text, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		lines := strings.Split(string(text), "\n")
		for _, line := range lines[1:] {
			c := strings.Fields(line)
			// Only a connected socket (state 01): a closed one in TIME_WAIT, root's in the table, can share the tuple, since
			// Linux reuses one for a new loopback connection (tcp_tw_reuse).
			if len(c) > 7 && c[3] == "01" && strings.EqualFold(c[1], want1) && strings.EqualFold(c[2], want2) {
				n, err := strconv.Atoi(c[7])
				if err != nil {
					return 0, false
				}
				uid = n
				found++
			}
		}
	}
	return uid, found == 1
}

// splitAddr is an address's IP and port.
func splitAddr(addr string) (net.IP, int, bool) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, 0, false
	}
	ip := net.ParseIP(host)
	n, err := strconv.Atoi(port)
	return ip, n, ip != nil && err == nil
}

// procAddr is ip:port as the kernel's socket table prints it: the address as 32-bit words in host order, in hex (IPv4
// as one word; in the IPv6 table four, an IPv4 address in its v4-mapped form), then the port.
func procAddr(ip net.IP, port int, v6 bool) string {
	b := ip.To4()
	if v6 {
		b = ip.To16()
	}
	var out strings.Builder
	for i := 0; i+4 <= len(b); i += 4 {
		fmt.Fprintf(&out, "%08X", binary.NativeEndian.Uint32(b[i:i+4]))
	}
	fmt.Fprintf(&out, ":%04X", port)
	return out.String()
}

// Direct is src/daemon.ts localDirect: a connection from a browser on this machine, as the daemon's own user (TS takes
// any non-root user). Loopback, not through tailscale serve (a root-owned socket), and not a peer's relay (x-stam-local) or forwarded agent (x-stam-agent). A session
// token is never accepted from a peer or relayed. Any local process holding a live token passes, agents included once
// they've read it from the browser's profile: the residual risk S-613 accepts.
func Direct(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !loopback[host] {
		return false
	}
	if _, ok := r.Header["X-Stam-Local"]; ok {
		return false
	}
	if _, ok := r.Header["X-Stam-Agent"]; ok {
		return false
	}
	// Only the daemon's own user, and never root (a forwarder such as tailscale serve): another local user is no human
	// of this daemon's.
	uid, ok := SocketUID(r)
	return ok && uid != 0 && uid == os.Getuid()
}
