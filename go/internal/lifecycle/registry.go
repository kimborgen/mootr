package lifecycle

import (
	"os"
	"path/filepath"

	"stam/internal/jsjson"
)

// Capabilities is src/registry.ts capabilitiesFor as the agents row stores it (JSON): the model's inputs and the
// harness's tools from the registry (registry/defaults.json, then the user registry (the home's cached copy on a peer) over it by name), and whether
// the registry knows the model. A model it doesn't know gets unknown (null) image and video inputs.
func (l *Lifecycle) Capabilities(harness, model string) (string, error) {
	defaults, err := readJSON(filepath.Join(l.claude.Templates.Root, "registry", "defaults.json"))
	if err != nil {
		return "", err
	}
	// A registry.json that is missing or not JSON counts as empty, as in TS.
	user := jsjson.Value(l.claude.Templates.UserRegistry())
	entry := func(section, key string) (jsjson.Value, bool) {
		var found jsjson.Value
		ok := false
		for _, doc := range []jsjson.Value{defaults, user} {
			o, _ := doc.(*jsjson.Object)
			if o == nil {
				continue
			}
			sec, _ := o.Get(section)
			so, _ := sec.(*jsjson.Object)
			if so == nil {
				continue
			}
			if v, has := so.Get(key); has {
				found, ok = v, true
			}
		}
		// A null entry is dropped from the merged registry.
		return found, ok && found != nil
	}
	member := func(v jsjson.Value, key string) jsjson.Value {
		o, _ := v.(*jsjson.Object)
		if o == nil {
			return nil
		}
		m, _ := o.Get(key)
		return m
	}
	var m jsjson.Value
	known := false
	if model != "" {
		m, known = entry("models", model)
	}
	inputs := member(m, "inputs")
	if inputs == nil {
		inputs = jsjson.NewObject("text", true, "image", nil, "video", nil)
	}
	h, _ := entry("harnesses", harness)
	tools := member(h, "tools")
	if tools == nil {
		tools = jsjson.NewObject()
	}
	return jsjson.Stringify(jsjson.NewObject("inputs", inputs, "tools", tools, "model_known", known), ""), nil
}

func readJSON(path string) (jsjson.Value, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return jsjson.Parse(b)
}
