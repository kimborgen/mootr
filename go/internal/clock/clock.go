// Package clock is the daemon's clock (S-3468): time.Now unless a test sets Now. Notices and the agent route's `now`
// read it, as src/clock.ts does in the TS daemon, so a test can fix the time.
package clock

import "time"

// Now is the clock. A test sets it and puts time.Now back when it ends.
var Now = time.Now
