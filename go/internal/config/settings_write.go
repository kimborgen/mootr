package config

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"stam/internal/jsjson"
)

// SetShared is SetSetting for a key the daemon sets itself (chiefOfStaff), with a dropped shared change logged.
func (f *SettingsFile) SetShared(key string, value jsjson.Value) error {
	warning, err := f.SetSetting(key, value)
	if warning != "" {
		slog.Warn(warning)
	}
	return err
}

// Text is src/settings.ts readSettingsText: settings.json as it is on disk, or "" when there is none.
func (f *SettingsFile) Text() (string, error) {
	data, err := os.ReadFile(f.path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return string(data), err
}

// Update is one write of settings.json: change gets the file's text and returns the text to write, or an error that
// writes nothing. Writers run one at a time, so a change is made over the text the last writer left, never over a
// copy another writer is replacing. The write is atomic (a temp file renamed over the old one, mode 0600 as
// src/settings.ts writeSecretFile), so a crash leaves the old file or the new one.
func (f *SettingsFile) Update(change func(current string) (string, error)) error {
	f.wmu.Lock()
	defer f.wmu.Unlock()
	current, err := f.Text()
	if err != nil {
		return err
	}
	next, err := change(current)
	if err != nil {
		return err
	}
	if err := writeAtomic(f.path, next); err != nil {
		return err
	}
	// The next Get reads the file again, even when its size and mtime look unchanged.
	f.changed()
	return nil
}

// writeAtomic writes text to path through a temp file in its folder, mode 0600, synced and renamed into place.
func writeAtomic(path, text string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(text); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
