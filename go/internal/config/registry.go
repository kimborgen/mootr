package config

import (
	"os"
	"path/filepath"
	"sync"

	"stam/internal/jsjson"
)

// registrySections are the sections src/registry.ts merges by key.
var registrySections = []string{"harnesses", "models", "presets", "prices", "types"}

// Registry is src/registry.ts registry: root's registry/defaults.json with the user registry (UserRegistry: the home's
// cached copy on a peer, else home's registry.json) over it, each section merged by key and a null entry removing a
// shipped one. A defaults file that is missing or not JSON reads as empty, as does a user registry that is (TS's catch);
// root "" has no defaults.
func Registry(root, home, machine string) *jsjson.Object {
	read := func(path string) *jsjson.Object {
		b, err := os.ReadFile(path)
		if err != nil {
			return jsjson.NewObject()
		}
		v, err := jsjson.Parse(b)
		if o := obj(v); err == nil && o != nil {
			return o
		}
		return jsjson.NewObject()
	}
	defaults := jsjson.NewObject()
	if root != "" {
		defaults = read(filepath.Join(root, "registry", "defaults.json"))
	}
	user := UserRegistry(home, machine)
	out := spread(defaults)
	for _, k := range user.Keys() {
		v, _ := user.Get(k)
		out.Set(k, v)
	}
	for _, k := range registrySections {
		d, _ := defaults.Get(k)
		u, _ := user.Get(k)
		merged := spread(d)
		for _, p := range pairs(u) {
			merged.Set(p[0].(string), p[1])
		}
		sec := jsjson.NewObject()
		for _, p := range pairs(merged) {
			if p[1] != nil {
				sec.Set(p[0].(string), p[1])
			}
		}
		out.Set(k, sec)
	}
	return out
}

// PeerShared is src/settings.ts peerShared: on a daemon whose settings.json names another settings home, the home's
// registry, instructions and type templates from the shared cache (S-387, S-417); nil on the home, with no cache, or
// with a cache that holds none of them. It reads only home's settings.json and the cache, kept until either file's stat
// changes.
func PeerShared(home, machine string) *SharedCache {
	file, cache := filepath.Join(home, "settings.json"), filepath.Join(home, "settings.shared.json")
	key := peerSharedKey{home: home, machine: machine, file: statKey(file), cache: statKey(cache)}
	peerSharedMemo.mu.Lock()
	defer peerSharedMemo.mu.Unlock()
	if v, ok := peerSharedMemo.byHome[home]; ok && v.key == key {
		return v.value
	}
	var value *SharedCache
	if b, err := os.ReadFile(file); err == nil {
		if user, err := jsjson.Parse(b); err == nil && jsjson.Truthy(user) && homeOf(user, machine) != machine {
			if raw, err := os.ReadFile(cache); err == nil {
				if c := parseSharedCache(raw); c != nil && (c.Registry != nil || c.Instructions != nil || c.Templates != nil) {
					value = c
				}
			}
		}
	}
	if peerSharedMemo.byHome == nil {
		peerSharedMemo.byHome = map[string]peerSharedEntry{}
	}
	peerSharedMemo.byHome[home] = peerSharedEntry{key: key, value: value}
	return value
}

type peerSharedKey struct {
	home, machine string
	file, cache   fileKey
}

type peerSharedEntry struct {
	key   peerSharedKey
	value *SharedCache
}

var peerSharedMemo struct {
	mu     sync.Mutex
	byHome map[string]peerSharedEntry
}

// UserRegistry is the user registry src/registry.ts merges over the shipped one: the home's copy from the shared cache
// on a peer that has one, else home's registry.json; empty when that is missing or not a JSON object.
func UserRegistry(home, machine string) *jsjson.Object {
	if c := PeerShared(home, machine); c != nil && c.Registry != nil {
		return obj(jsjson.Clone(c.Registry))
	}
	b, err := os.ReadFile(filepath.Join(home, "registry.json"))
	if err != nil {
		return jsjson.NewObject()
	}
	if v, err := jsjson.Parse(b); err == nil && obj(v) != nil {
		return obj(v)
	}
	return jsjson.NewObject()
}
