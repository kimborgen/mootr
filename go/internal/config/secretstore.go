package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// The secret store (src/secrets.ts, S-2114): provider keys and MCP client secrets in STAM_HOME/secrets.json (mode 600),
// apart from settings.json, which holds only a reference by name, {"secret": "NAME"}. No route returns a value: a value
// leaves this file only as a Secret, which renders redacted, through Get and Stored. A missing file is an empty store;
// any other problem reading it (a symlink, not a regular file, unreadable, not JSON) is a *SecretError with File set,
// which refuses every write and list, and reads as empty only to the readers that must not fail (Get, ProviderOf).

// SecretError is a refusal of the store: File when secrets.json itself is broken (a 409), else a bad request (a 400).
// Its message never holds a value.
type SecretError struct {
	Message string
	File    bool
}

func (e *SecretError) Error() string { return e.Message }

// SecretTest is the last result of testing a secret against its provider.
type SecretTest struct {
	OK     bool   `json:"ok"`
	At     string `json:"at"`
	Detail string `json:"detail,omitempty"`
}

// SecretInfo is what a route may show about a secret: never its value.
type SecretInfo struct {
	Name         string      `json:"name"`
	Provider     string      `json:"provider"`
	Slot         string      `json:"slot"`
	Env          *string     `json:"env"`
	Last4        string      `json:"last4"`
	SetAt        string      `json:"setAt"`
	Test         *SecretTest `json:"test"`
	OverriddenBy *string     `json:"overriddenBy"`
}

// secretEntry is one secret in memory. Its value is a Secret in an exported field, so fmt calls its String and GoString
// and it renders redacted anywhere it is printed (fmt can't call a method of an unexported field).
type secretEntry struct {
	Value    Secret
	provider string
	slot     string
	env      string
	setAt    string
	test     *SecretTest
}

type secretStore struct {
	secrets  map[string]secretEntry
	order    []string // the names in insertion order, as a JS object keeps them
	imported []string
}

// put sets a secret, a new name last.
func (st *secretStore) put(name string, e secretEntry) {
	if _, ok := st.secrets[name]; !ok {
		st.order = append(st.order, name)
	}
	st.secrets[name] = e
}

// drop deletes a secret.
func (st *secretStore) drop(name string) {
	delete(st.secrets, name)
	st.order = slices.DeleteFunc(slices.Clone(st.order), func(n string) bool { return n == name })
}

func (st secretStore) clone() secretStore {
	out := secretStore{secrets: make(map[string]secretEntry, len(st.secrets)), order: slices.Clone(st.order), imported: slices.Clone(st.imported)}
	for k, v := range st.secrets {
		out.secrets[k] = v
	}
	return out
}

func (st secretStore) hasImported(f string) bool {
	for _, x := range st.imported {
		if x == f {
			return true
		}
	}
	return false
}

// Secrets is one home's secret store. Its writes are read-modify-write under mu, written atomically.
type Secrets struct {
	home   string
	getenv func(string) string
	now    func() time.Time

	mu     sync.Mutex
	memo   *secretStore
	key    string
	warned map[string]bool
}

// NewSecrets returns the store of home; getenv is the daemon's environment, whose variables override the secrets that
// stand for them.
func NewSecrets(home string, getenv func(string) string) *Secrets {
	return &Secrets{home: home, getenv: getenv, now: time.Now, warned: map[string]bool{}}
}

const maxSecretValue = 8192

func (s *Secrets) file() string { return filepath.Join(s.home, "secrets.json") }

func fileErr(format string, a ...any) *SecretError {
	return &SecretError{Message: fmt.Sprintf(format, a...), File: true}
}

// read is the store as on disk. The file is opened without following a symlink and checked on the open descriptor: a
// file with group or other bits is narrowed to 600. Only ENOENT is an empty store; every other error refuses.
func (s *Secrets) read() (secretStore, error) {
	f, err := os.OpenFile(s.file(), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.memo, s.key = nil, "none"
			return secretStore{secrets: map[string]secretEntry{}}, nil
		}
		return secretStore{}, fileErr("secrets.json can't be read: %s", errnoCode(err))
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return secretStore{}, fileErr("secrets.json can't be read: %s", errnoCode(err))
	}
	if !info.Mode().IsRegular() {
		return secretStore{}, fileErr("secrets.json is not a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		if err := f.Chmod(0o600); err != nil {
			return secretStore{}, fileErr("secrets.json can't be narrowed to 600: %s", errnoCode(err))
		}
		slog.Warn("secrets.json had group or other permissions; narrowed to 600")
	}
	key := secretsKey(info)
	if s.memo != nil && s.key == key {
		return *s.memo, nil
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return secretStore{}, fileErr("secrets.json can't be read: %s", errnoCode(err))
	}
	st, err := parseSecrets(b)
	if err != nil {
		return secretStore{}, err
	}
	s.memo, s.key = &st, key
	return st, nil
}

// errnoCode is the error's errno name (ENOENT, ELOOP), as TS's e.code: never a path or a value.
func errnoCode(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name := errnoNames[errno]; name != "" {
			return name
		}
		return "errno " + strconv.Itoa(int(errno))
	}
	return "error"
}

var errnoNames = map[syscall.Errno]string{
	syscall.EACCES: "EACCES", syscall.ELOOP: "ELOOP", syscall.EISDIR: "EISDIR", syscall.ENOTDIR: "ENOTDIR",
	syscall.EIO: "EIO", syscall.EPERM: "EPERM", syscall.EMFILE: "EMFILE", syscall.ENFILE: "ENFILE", syscall.EROFS: "EROFS",
	syscall.ENOSPC: "ENOSPC", syscall.EEXIST: "EEXIST",
}

func secretsKey(info os.FileInfo) string {
	ino := uint64(0)
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		ino = st.Ino
	}
	return fmt.Sprintf("%d:%d:%d", ino, info.Size(), info.ModTime().UnixNano())
}

// parseSecrets is read's parse: an entry with a bad name or no string value is dropped, as TS does.
func parseSecrets(b []byte) (secretStore, error) {
	v, err := jsjson.Parse(b)
	if err != nil {
		return secretStore{}, fileErr("secrets.json is not valid JSON")
	}
	st := secretStore{secrets: map[string]secretEntry{}}
	root, _ := v.(*jsjson.Object)
	if imp, ok := root.Get("imported"); ok {
		if arr, ok := imp.([]jsjson.Value); ok {
			for _, x := range arr {
				if s, ok := x.(string); ok {
					st.imported = append(st.imported, s)
				}
			}
		}
	}
	all, _ := root.Get("secrets")
	obj, _ := all.(*jsjson.Object)
	for _, name := range obj.Keys() {
		raw, _ := obj.Get(name)
		e, _ := raw.(*jsjson.Object)
		value, _ := field(e, "value").(string)
		if !secretName.MatchString(name) || value == "" {
			continue
		}
		entry := secretEntry{Value: Secret(value), slot: "stam"}
		entry.provider, _ = field(e, "provider").(string)
		if field(e, "slot") == "agent" {
			entry.slot = "agent"
		}
		if env, ok := field(e, "env").(string); ok && envName.MatchString(env) {
			entry.env = env
		}
		entry.setAt, _ = field(e, "setAt").(string)
		if t, ok := field(e, "test").(*jsjson.Object); ok && jsjson.Truthy(t) {
			if okv, isBool := field(t, "ok").(bool); isBool {
				at := ""
				if a := field(t, "at"); a != nil {
					at = jsjson.ToString(a)
				}
				test := &SecretTest{OK: okv, At: at}
				if d := field(t, "detail"); jsjson.Truthy(d) {
					test.Detail = jsjson.ToString(d)
				}
				entry.test = test
			}
		}
		st.put(name, entry)
	}
	return st, nil
}

// field is `o?.[k]`: nil (undefined) when o isn't an object or lacks k.
func field(o jsjson.Value, k string) jsjson.Value {
	obj, ok := o.(*jsjson.Object)
	if !ok || obj == nil {
		return nil
	}
	v, _ := obj.Get(k)
	return v
}

// write writes the store atomically, as JSON.stringify(store, null, 2): a new file created with mode 600 beside it
// (never following a symlink), synced, then renamed over.
func (s *Secrets) write(st secretStore) error {
	all := jsjson.NewObject()
	for _, n := range st.order {
		e := st.secrets[n]
		o := jsjson.NewObject("value", e.Value.Reveal(), "provider", e.provider, "slot", e.slot)
		if e.env != "" {
			o.Set("env", e.env)
		}
		o.Set("setAt", e.setAt)
		if e.test != nil {
			t := jsjson.NewObject("ok", e.test.OK, "at", e.test.At)
			if e.test.Detail != "" {
				t.Set("detail", e.test.Detail)
			}
			o.Set("test", t)
		}
		all.Set(n, o)
	}
	imported := make([]jsjson.Value, len(st.imported))
	for i, x := range st.imported {
		imported[i] = x
	}
	text := jsjson.Stringify(jsjson.NewObject("secrets", all, "imported", imported), "  ") + "\n"
	tmp := fmt.Sprintf("%s.%d.%d.tmp", s.file(), os.Getpid(), s.now().UnixMilli())
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fileErr("secrets.json can't be written: %s", errnoCode(err))
	}
	werr := f.Chmod(0o600)
	if werr == nil {
		_, werr = f.WriteString(text)
	}
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp, s.file())
	}
	if werr != nil {
		os.Remove(tmp)
		return fileErr("secrets.json can't be written: %s", errnoCode(werr))
	}
	s.memo = nil
	return nil
}

// NameForEnv is src/secrets.ts nameForEnv: the store name and provider for a variable (OPENROUTER_API_KEY is
// "openrouter").
func NameForEnv(v string) string {
	n := strings.ReplaceAll(strings.ToLower(keyVar.ReplaceAllString(v, "")), "_", "-")
	n = strings.TrimLeftFunc(n, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') })
	if n == "" {
		return "key"
	}
	return n
}

// importLegacyOnce is src/secrets.ts importLegacyOnce: each key line of opencode.env becomes a `stam` secret and a
// separate `agent` secret with the same value, once per home. A secret already under a name is kept. It logs names only.
func (s *Secrets) importLegacyOnce() error {
	cur, err := s.read()
	if err != nil {
		return err
	}
	if cur.hasImported("opencode.env") {
		return nil
	}
	lines := legacyLines(filepath.Join(s.home, "opencode.env"), false)
	var keys []string
	for k := range lines {
		if keyVar.MatchString(k) {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	sort.Strings(keys)
	st := cur.clone()
	at := isoTime(s.now())
	var added []string
	for _, v := range keys {
		provider := NameForEnv(v)
		for _, ns := range [][2]string{{provider, "stam"}, {provider + "-agent", "agent"}} {
			if _, held := st.secrets[ns[0]]; !secretName.MatchString(ns[0]) || held {
				continue
			}
			st.put(ns[0], secretEntry{Value: Secret(lines[v]), provider: provider, slot: ns[1], env: v, setAt: at})
			added = append(added, ns[0])
		}
	}
	st.imported = append(st.imported, "opencode.env")
	if err := s.write(st); err != nil {
		return err
	}
	if len(added) > 0 {
		slog.Info("secrets: imported " + strings.Join(added, ", ") + " from opencode.env")
	}
	return nil
}

func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// load is the store after the one-time import; a broken file refuses.
func (s *Secrets) load() (secretStore, error) {
	if err := s.importLegacyOnce(); err != nil {
		return secretStore{}, err
	}
	return s.read()
}

// readable is the store for a reader that must not fail: a broken file reads as empty, and the daemon says why once per
// reason.
func (s *Secrets) readable() secretStore {
	st, err := s.load()
	if err != nil {
		if !s.warned[err.Error()] {
			s.warned[err.Error()] = true
			slog.Warn("secrets: " + err.Error() + "; using the environment and opencode.env only")
		}
		return secretStore{secrets: map[string]secretEntry{}}
	}
	return st
}

// Init reads the store at startup and runs the import. A broken file is logged, not fatal.
func (s *Secrets) Init() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readable()
}

// Get is a secret's value by name, for in-process use only: the variable it stands for overrides it. False when none.
func (s *Secrets) Get(name string) (Secret, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.readable().secrets[name]
	if !ok {
		return "", false
	}
	if e.env != "" {
		if v := s.getenv(e.env); v != "" {
			return Secret(v), true
		}
	}
	return e.Value, true
}

// Stored is the value the human entered and the variable it stands for, without the environment's override. In-process
// only. A broken file refuses; false when there is none.
func (s *Secrets) Stored(name string) (value Secret, env string, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return "", "", false, err
	}
	e, ok := st.secrets[name]
	return e.Value, e.env, ok, nil
}

// ProviderOf is the provider a stored secret is tagged with; false when the store holds no entry by that name.
func (s *Secrets) ProviderOf(name string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.readable().secrets[name]
	return e.provider, ok
}

// List is what a route may show: names, provider, slot, the last 4 characters and the last test result, by name.
func (s *Secrets) List() ([]SecretInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(st.secrets))
	for n := range st.secrets {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]SecretInfo, 0, len(names))
	for _, n := range names {
		out = append(out, s.info(n, st.secrets[n]))
	}
	return out, nil
}

func (s *Secrets) info(name string, e secretEntry) SecretInfo {
	in := SecretInfo{Name: name, Provider: e.provider, Slot: e.slot, SetAt: e.setAt, Test: e.test}
	if v := e.Value.Reveal(); jsLen(v) > 8 {
		u := utf16.Encode([]rune(v))
		in.Last4 = string(utf16.Decode(u[len(u)-4:]))
	}
	if e.env != "" {
		env := e.env
		in.Env = &env
		if s.getenv(e.env) != "" {
			by := "env"
			in.OverriddenBy = &by
		}
	}
	return in
}

// jsLen is a string's length as JS counts it, in UTF-16 code units.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// printable is src/llm/http.ts checkCredential: printable ASCII, no space.
func printable(v string) bool {
	for i := 0; i < len(v); i++ {
		if v[i] < 0x21 || v[i] > 0x7e {
			return false
		}
	}
	return v != ""
}

func badSecret(msg string) *SecretError { return &SecretError{Message: msg} }

// Set sets a secret from a request body ({value, provider?, slot?, env?}; env null drops it). A new value clears the
// last test result. It returns the secret's info, never the value; a refusal never quotes the value.
func (s *Secrets) Set(name string, body jsjson.Value) (SecretInfo, error) {
	if !secretName.MatchString(name) {
		return SecretInfo{}, badSecret("a secret name is 1-64 characters: lower-case letters, digits, dot, dash and underscore")
	}
	value, isStr := field(body, "value").(string)
	if !isStr || jsjson.Trim(value) == "" {
		return SecretInfo{}, badSecret("value must be a non-empty string")
	}
	if jsLen(value) > maxSecretValue {
		return SecretInfo{}, badSecret(fmt.Sprintf("value is over %d characters", maxSecretValue))
	}
	if strings.ContainsAny(value, "\r\n\x00") {
		return SecretInfo{}, badSecret("value must be one line")
	}
	value = jsjson.Trim(value)
	if !printable(value) {
		return SecretInfo{}, badSecret("value must be printable ASCII with no spaces")
	}
	o, _ := body.(*jsjson.Object)
	slot, hasSlot := o.Get("slot")
	if hasSlot && slot != "stam" && slot != "agent" {
		return SecretInfo{}, badSecret("slot must be stam or agent")
	}
	env, hasEnv := o.Get("env")
	if hasEnv && env != nil {
		if e, ok := env.(string); !ok || !envName.MatchString(e) {
			return SecretInfo{}, badSecret("env must be an environment variable name")
		}
	}
	provider, hasProvider := o.Get("provider")
	if hasProvider {
		if p, ok := provider.(string); !ok || jsLen(p) > 64 {
			return SecretInfo{}, badSecret("provider must be a short string")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.load()
	if err != nil {
		return SecretInfo{}, err
	}
	st := cur.clone()
	prev, had := st.secrets[name]
	entry := secretEntry{Value: Secret(value), provider: prev.provider, slot: "stam", setAt: isoTime(s.now())}
	if had {
		entry.slot = prev.slot
	}
	if hasProvider {
		entry.provider = provider.(string)
	}
	if hasSlot {
		entry.slot = slot.(string)
	}
	switch {
	case hasEnv && env == nil:
	case hasEnv:
		entry.env = env.(string)
	default:
		entry.env = prev.env
	}
	st.put(name, entry)
	if err := s.write(st); err != nil {
		return SecretInfo{}, err
	}
	return s.info(name, entry), nil
}

// Remove deletes a secret; false when there was none.
func (s *Secrets) Remove(name string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.load()
	if err != nil {
		return false, err
	}
	if _, ok := cur.secrets[name]; !ok {
		return false, nil
	}
	st := cur.clone()
	st.drop(name)
	return true, s.write(st)
}

// RecordTest records the result of testing a secret against its provider. The detail is the provider's text, which may
// echo the key: the value and any long token-like run are cut out, and it is capped at 200 characters.
func (s *Secrets) RecordTest(name string, ok bool, detail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.load()
	if err != nil {
		return err
	}
	e, had := cur.secrets[name]
	if !had {
		return nil
	}
	st := cur.clone()
	if detail != "" {
		detail = Scrub(detail, e.Value.Reveal())
	}
	e.test = &SecretTest{OK: ok, At: isoTime(s.now()), Detail: detail}
	st.put(name, e)
	return s.write(st)
}

// McpClientSecretName is the store name of an MCP server's OAuth client secret (S-2736): `mcp-SLUG-HASH-client`. The
// hash is of the raw name, so two names that sanitize alike never share a secret. False when no such name fits.
func McpClientSecretName(server string) (string, bool) {
	slug := mcpSlugBad.ReplaceAllString(strings.ToLower(server), "-")
	slug = strings.TrimLeftFunc(slug, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') })
	if u := utf16.Encode([]rune(slug)); len(u) > 40 {
		slug = string(utf16.Decode(u[:40]))
	}
	sum := sha256.Sum256([]byte(server))
	name := "mcp-" + slug + "-" + hex.EncodeToString(sum[:])[:8] + "-client"
	return name, secretName.MatchString(name)
}

var mcpSlugBad = regexp.MustCompile(`[^a-z0-9._-]`)

// SetMcpClientSecret stores an MCP server's client secret under its name (replacing one there) and returns the name the
// reference takes. A store that refuses errors, so the caller writes nothing.
func (s *Secrets) SetMcpClientSecret(server, value string) (string, error) {
	name, ok := McpClientSecretName(server)
	if !ok {
		return "", badSecret(server + " has no name the secret store can hold")
	}
	body := jsjson.NewObject()
	body.Set("value", value)
	body.Set("provider", "mcp")
	if _, err := s.Set(name, body); err != nil {
		return "", err
	}
	return name, nil
}

var tokenRun = regexp.MustCompile(`[A-Za-z0-9_\-*.]{16,}`)

// Scrub is src/secrets.ts scrub: the value replaced by [key], token-like runs by […], capped at 200 UTF-16 units.
func Scrub(text, value string) string {
	if value != "" {
		text = strings.ReplaceAll(text, value, "[key]")
	}
	text = tokenRun.ReplaceAllString(text, "[…]")
	if u := utf16.Encode([]rune(text)); len(u) > 200 {
		text = string(utf16.Decode(u[:200]))
	}
	return text
}

// IsSecretRef is src/secrets.ts isRef: an object whose only key is a string `secret`.
func IsSecretRef(v jsjson.Value) (string, bool) {
	o, ok := v.(*jsjson.Object)
	if !ok || o == nil || o.Len() != 1 {
		return "", false
	}
	name, ok := field(o, "secret").(string)
	return name, ok
}
