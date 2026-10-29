package localhuman

import (
	"os"
	"syscall"
	"time"
)

// statCtime is a file's status change time: when root's install made it.
func statCtime(st *syscall.Stat_t) time.Time { return time.Unix(st.Ctim.Unix()) }

// KernelNow is now on the clock a file's ctime is stamped with: the kernel's coarse clock, which can trail time.Now by
// a tick. A daemon's start taken from it is never later than the ctime of a code made after it. It falls back to
// time.Now when no file can be made.
func KernelNow() time.Time {
	f, err := os.CreateTemp("", "stam-start-*")
	if err != nil {
		return time.Now()
	}
	defer os.Remove(f.Name())
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return time.Now()
	}
	return statCtime(&st)
}
