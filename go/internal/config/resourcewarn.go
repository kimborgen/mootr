package config

import (
	"encoding/json"
	"math"
)

// ResourceWarn is settings.resourceWarn (src/settings.ts resourceWarnOf): the lines past which this machine's sampler
// mails a resource warning, and when each kind last mailed.
type ResourceWarn struct {
	Enabled        bool
	LoadPerCore    float64
	RamAvailableGb float64
	SwapPct        float64
	DiskPct        float64
	RepeatMinutes  float64
	// Recipients are agent names or "human"; none means the chief of staff.
	Recipients []string
	// LastWarned is when each kind (cpu, ram, swap, disk) last mailed, in epoch ms; nil for never (for disk: armed).
	LastWarned map[string]*float64
}

// ResourceWarnKinds are the kinds lastWarned holds, in src/settings.ts order.
var ResourceWarnKinds = []string{"cpu", "ram", "swap", "disk"}

// parseResourceWarn is src/settings.ts resourceWarnOf over the file's resourceWarn value.
func parseResourceWarn(data []byte) ResourceWarn {
	var user struct {
		ResourceWarn map[string]any `json:"resourceWarn"`
	}
	if len(data) > 0 {
		_ = json.Unmarshal(data, &user)
	}
	u := user.ResourceWarn
	num := func(v any, def float64) float64 {
		if f, ok := v.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0 {
			return f
		}
		return def
	}
	out := ResourceWarn{
		Enabled:        u["enabled"] != false,
		LoadPerCore:    num(u["loadPerCore"], 2),
		RamAvailableGb: num(u["ramAvailableGb"], 2),
		SwapPct:        num(u["swapPct"], 80),
		DiskPct:        num(u["diskPct"], 85),
		RepeatMinutes:  num(u["repeatMinutes"], 30),
		Recipients:     []string{},
		LastWarned:     map[string]*float64{},
	}
	if list, ok := u["recipients"].([]any); ok {
		for _, r := range list {
			if s, ok := r.(string); ok && s != "" {
				out.Recipients = append(out.Recipients, s)
			}
		}
	}
	last, _ := u["lastWarned"].(map[string]any)
	for _, k := range ResourceWarnKinds {
		if f := num(last[k], -1); f >= 0 {
			out.LastWarned[k] = &f
		}
	}
	return out
}
