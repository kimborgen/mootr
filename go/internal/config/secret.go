package config

import (
	"encoding/json"
	"log/slog"
)

// Secret is a token that never renders: JSON, fmt and slog all show it redacted. Reveal returns the value.
type Secret string

const redacted = "[redacted]"

// Reveal returns the secret's value, for hashing or comparing it; never log or send it.
func (s Secret) Reveal() string { return string(s) }

func (s Secret) String() string               { return redacted }
func (s Secret) GoString() string             { return redacted }
func (s Secret) LogValue() slog.Value         { return slog.StringValue(redacted) }
func (s Secret) MarshalJSON() ([]byte, error) { return json.Marshal(redacted) }
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }
