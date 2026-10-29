package config

import (
	"reflect"
	"testing"
)

// settings.resourceWarn as src/settings.ts resourceWarnOf reads it: a line that isn't a number of at least 0 is its
// default, recipients keep the non-empty strings, and lastWarned only the times.
func TestResourceWarnSettings(t *testing.T) {
	d := parseResourceWarn(nil)
	if !d.Enabled || d.LoadPerCore != 2 || d.RamAvailableGb != 2 || d.SwapPct != 80 || d.DiskPct != 85 || d.RepeatMinutes != 30 ||
		len(d.Recipients) != 0 || len(d.LastWarned) != 0 {
		t.Errorf("defaults: %+v", d)
	}
	s, err := ParseSettings([]byte(`{"resourceWarn":{"enabled":false,"loadPerCore":-1,"ramAvailableGb":"3","swapPct":0,"diskPct":90.5,
		"recipients":["cos","",3,"human"],"lastWarned":{"cpu":5,"ram":-1,"swap":"x","disk":0,"other":7}}}`), "m1")
	if err != nil {
		t.Fatal(err)
	}
	r := s.ResourceWarn
	if r.Enabled || r.LoadPerCore != 2 || r.RamAvailableGb != 2 || r.SwapPct != 0 || r.DiskPct != 90.5 || !reflect.DeepEqual(r.Recipients, []string{"cos", "human"}) {
		t.Errorf("parsed: %+v", r)
	}
	if len(r.LastWarned) != 2 || *r.LastWarned["cpu"] != 5 || *r.LastWarned["disk"] != 0 {
		t.Errorf("lastWarned: %v", r.LastWarned)
	}
	if r := parseResourceWarn([]byte(`{"resourceWarn":"on"}`)); !r.Enabled || r.DiskPct != 85 {
		t.Errorf("not an object: %+v", r)
	}
}
