package opencode

import (
	"regexp"
	"strings"

	"stam/internal/jsjson"
	"stam/internal/llm"
	"stam/internal/tmux"
)

// ProviderBlocks is src/adapters/opencode-providers.ts opencodeProviders' result: the `provider` blocks for
// opencode.json, the server env that carries their keys, and the ids left out because their key variables collide.
type ProviderBlocks struct {
	Blocks     *jsjson.Object
	Env        tmux.Env
	Collisions []string
}

var (
	providerID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	notEnvChar   = regexp.MustCompile(`[^A-Z0-9]`)
	openAIHost   = regexp.MustCompile(`^https://api\.openai\.com(/|$)`)
	azureSuffix  = regexp.MustCompile(`/openai(/v1)?$`)
	azureHost    = regexp.MustCompile(`(?i)^https://([a-z0-9-]+)\.openai\.azure\.com$`)
	azureV1Path  = regexp.MustCompile(`/openai/v1/*$`)
	trailSlashes = regexp.MustCompile(`/+$`)
)

// KeyEnvName is src/adapters/opencode-providers.ts keyEnvName: the variable that carries a provider's key into the
// OpenCode server.
func KeyEnvName(id string) string {
	return "STAM_PROVIDER_" + notEnvChar.ReplaceAllString(strings.ToUpper(id), "_") + "_KEY"
}

// Providers is src/adapters/opencode.ts providers over opencodeProviders (S-2118): each settings.providers entry as an
// OpenCode provider block keyed by stam's id, naming the AI SDK package for its kind, so an agent can run on it as
// `PROVIDER/MODEL`. A key never goes in a block: the block's apiKey is `{env:STAM_PROVIDER_<ID>_KEY}`, and that variable
// is in Env alone, for the server's environment. An entry that doesn't parse, or the id `openrouter` (whose key OpenCode
// reads from the server's env itself), is left out; a provider with no key gets none. Ids whose key variables would be the
// same are all left out and named in Collisions, so one provider never sends another's key to its host. A registry TS
// would throw on reads as no providers at all, as TS's catch does.
func Providers(e Env) ProviderBlocks {
	out := ProviderBlocks{Blocks: jsjson.NewObject()}
	type parsed struct {
		id string
		p  *llm.Provider
	}
	var list []parsed
	for _, id := range e.Settings.ProviderOrder {
		if id == "openrouter" || !providerID.MatchString(id) {
			continue
		}
		if p := llm.ParseProvider(e.Settings.Providers[id]); p != nil {
			list = append(list, parsed{id, p})
		}
	}
	byEnv := map[string][]string{}
	var envOrder []string
	for _, x := range list {
		k := KeyEnvName(x.id)
		if _, ok := byEnv[k]; !ok {
			envOrder = append(envOrder, k)
		}
		byEnv[k] = append(byEnv[k], x.id)
	}
	collides := map[string]bool{}
	for _, k := range envOrder {
		if ids := byEnv[k]; len(ids) > 1 {
			out.Collisions = append(out.Collisions, ids...)
			for _, id := range ids {
				collides[id] = true
			}
		}
	}
	for _, x := range list {
		if collides[x.id] {
			continue
		}
		ms, ok := models(x.id, e.Registry)
		if !ok {
			return ProviderBlocks{Blocks: jsjson.NewObject()}
		}
		envName := KeyEnvName(x.id)
		key := x.p.Key(e.Home, e.Getenv)
		if key != "" {
			out.Env = out.Env.Set(envName, key)
		}
		withKey := func(o *jsjson.Object) *jsjson.Object {
			if key != "" {
				o.Set("apiKey", "{env:"+envName+"}")
			}
			return o
		}
		var npm string
		options := jsjson.NewObject()
		switch x.p.Kind {
		case "openai-compatible":
			npm = "@ai-sdk/openai-compatible"
			if openAIHost.MatchString(x.p.BaseURL) {
				npm = "@ai-sdk/openai"
			}
			options.Set("baseURL", trailSlashes.ReplaceAllString(x.p.BaseURL, ""))
		case "azure":
			// A resource endpoint names the resource; any other endpoint is the base URL, up to /openai.
			endpoint := azureSuffix.ReplaceAllString(trailSlashes.ReplaceAllString(x.p.Endpoint, ""), "")
			if m := azureHost.FindStringSubmatch(endpoint); m != nil {
				options.Set("resourceName", m[1])
			} else {
				options.Set("baseURL", endpoint+"/openai")
			}
			if x.p.APIVersion != "v1" && !azureV1Path.MatchString(x.p.Endpoint) {
				options.Set("apiVersion", x.p.APIVersion)
				options.Set("useDeploymentBasedUrls", true)
			}
			npm = "@ai-sdk/azure"
			if d := x.p.Deployment; d != "" {
				if _, ok := ms.Get(d); !ok {
					ms.Set(d, jsjson.NewObject("name", d))
				}
			}
		default:
			npm = "@ai-sdk/amazon-bedrock"
			options.Set("region", x.p.Region)
			if x.p.Profile != "" {
				options.Set("profile", x.p.Profile)
			}
			if x.p.Endpoint != "" {
				options.Set("endpoint", x.p.Endpoint)
			}
		}
		block := jsjson.NewObject("npm", npm, "name", x.id, "options", withKey(options))
		if ms.Len() > 0 {
			block.Set("models", ms)
		}
		out.Blocks.Set(x.id, block)
	}
	return out
}

// models is src/adapters/opencode-providers.ts models: the registry's OpenCode models on one provider (`ID/MODEL`) as
// OpenCode model entries, with the registry's per-provider price as their cost so OpenCode's own session cost uses it.
// False where TS throws: a model's `harnesses` that is truthy but has no includes.
func models(id string, reg *jsjson.Object) (*jsjson.Object, bool) {
	out := jsjson.NewObject()
	all, _ := reg.Get("models")
	mo, _ := all.(*jsjson.Object)
	prices, _ := reg.Get("prices")
	po, _ := prices.(*jsjson.Object)
	for _, full := range mo.Keys() {
		if !strings.HasPrefix(full, id+"/") {
			continue
		}
		m, _ := mo.Get(full)
		mobj, _ := m.(*jsjson.Object)
		if h, _ := mobj.Get("harnesses"); jsjson.Truthy(h) {
			// `m.harnesses.includes('opencode')`: an array's items, a string's text.
			switch x := h.(type) {
			case []jsjson.Value:
				if !includes(x, "opencode") {
					continue
				}
			case string:
				if !strings.Contains(x, "opencode") {
					continue
				}
			default:
				return nil, false
			}
		}
		short := full[len(id)+1:]
		name := short
		if n, _ := mobj.Get("name"); n != nil {
			if s, ok := n.(string); ok && s != "" {
				name = s
			}
		}
		entry := jsjson.NewObject("name", name)
		p, _ := po.Get(full)
		pobj, _ := p.(*jsjson.Object)
		in, inOK := number(pobj, "input")
		outp, outOK := number(pobj, "output")
		if inOK && outOK {
			cost := jsjson.NewObject("input", in, "output", outp)
			if v, ok := number(pobj, "cacheRead"); ok {
				cost.Set("cache_read", v)
			}
			if v, ok := number(pobj, "cacheWrite"); ok {
				cost.Set("cache_write", v)
			}
			entry.Set("cost", cost)
		}
		out.Set(short, entry)
	}
	return out, true
}

func includes(list []jsjson.Value, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// number is `typeof o[k] === 'number'`.
func number(o *jsjson.Object, k string) (float64, bool) {
	v, _ := o.Get(k)
	f, ok := v.(float64)
	return f, ok
}
