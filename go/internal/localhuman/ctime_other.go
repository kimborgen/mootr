//go:build !linux

package localhuman

import (
	"syscall"
	"time"
)

// statCtime isn't reached off Linux: Redeem refuses there first.
func statCtime(*syscall.Stat_t) time.Time { return time.Time{} }

// KernelNow is time.Now off Linux, where no code is redeemed.
func KernelNow() time.Time { return time.Now() }
