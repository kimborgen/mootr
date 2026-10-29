package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

var warnBoth sync.Once

func notFound(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// DefaultHomes is src/default-home.ts defaultHomes (src/config.ts DEFAULT_HOMES): both spellings of the default home, whether or not either exists.
func DefaultHomes(userHome string) []string {
	return []string{filepath.Join(userHome, ".local", "share", "stam"), filepath.Join(userHome, ".local", "share", "mootr")}
}

// DefaultHome is src/default-home.ts defaultHome (S-3347, S-4335): ~/.local/share/stam when it is a real directory (lstat,
// links not followed), else ~/.local/share/mootr, so a fresh install gets mootr. A stray mootr folder never takes over a
// real stam home; after the move stam is a symlink, so mootr wins. When both are real directories stam wins and a warning
// is logged once. Only "not found" falls through; another error on the stam path (EACCES) is returned, never mootr.
func DefaultHome(userHome string) (string, error) {
	stam, mootr := DefaultHomes(userHome)[0], DefaultHomes(userHome)[1]
	fi, err := os.Lstat(stam)
	if err != nil && !notFound(err) {
		return "", fmt.Errorf("config: can't inspect %s: %w", stam, err)
	}
	if err != nil || !fi.IsDir() {
		return mootr, nil
	}
	if _, merr := os.Stat(mootr); merr == nil {
		warnBoth.Do(func() { fmt.Fprintf(os.Stderr, "default home: %s and %s are both real folders; using %s\n", stam, mootr, stam) })
	}
	return stam, nil
}
