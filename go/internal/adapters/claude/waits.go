package claude

import (
	"regexp"
	"strconv"
	"time"

	"stam/internal/cron"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// Waits that Claude Code itself creates (src/adapters/claude.ts, source 'hook'): background work that outlives the turn
// ('job': Bash or Monitor with run_in_background, Agent with run_in_background) and timers ('timer': CronCreate, and
// ScheduleWakeup, which Claude Code stores as a one-shot cron). Every Stop payload carries Claude Code's own list of what
// is still open, `background_tasks` and `session_crons`, so each Stop replaces the agent's hook waits with it. Between
// turns, a job ending or a timer firing starts a turn whose prompt names it, and its wait clears then. A new process has
// none of the old one's, so SessionStart on startup or resume drops them.

// HookWaits is what one hook does to the agent's hook waits; the zero value does nothing.
type HookWaits struct {
	// Clear drops every hook wait (SessionStart on startup or resume).
	Clear bool
	// Jobs and Timers, when not nil, are the agent's hook waits of kind job and timer from now on (Stop).
	Jobs, Timers []db.HookWait
	// Prompt, when not nil, is a submitted prompt, which clears the job or one-shot timer that started its turn.
	Prompt *string
}

var jobLabel = map[string]string{"shell": "background command", "subagent": "background agent", "monitor": "monitor"}

// stopWaits is src/adapters/claude.ts syncStopWaits's lists: a list the payload doesn't carry as an array stays nil.
func stopWaits(p *jsjson.Object, now time.Time) (jobs, timers []db.HookWait) {
	if tasks, ok := get(p, "background_tasks").([]jsjson.Value); ok {
		jobs = []db.HookWait{}
		for _, v := range tasks {
			t, _ := v.(*jsjson.Object)
			status := get(t, "status")
			if status == nil {
				status = "running"
			}
			if t == nil || !jsjson.Truthy(get(t, "id")) || status != "running" {
				continue
			}
			typ, hasType := t.Get("type")
			label := "job"
			if s, ok := typ.(string); ok && jobLabel[s] != "" {
				label = jobLabel[s]
			} else if typ != nil {
				label = JSString(typ)
			}
			what := get(t, "description")
			if what == nil {
				what = get(t, "command")
			}
			if what == nil {
				what = get(t, "id")
			}
			data := jsjson.NewObject()
			if hasType {
				data.Set("type", typ)
			}
			d := jsjson.Stringify(data, "")
			jobs = append(jobs, db.HookWait{Target: JSString(get(t, "id")), Detail: label + " \"" + JSString(what) + "\"", Data: &d})
		}
	}
	if crons, ok := get(p, "session_crons").([]jsjson.Value); ok {
		timers = []db.HookWait{}
		for _, v := range crons {
			c, _ := v.(*jsjson.Object)
			if c == nil || !jsjson.Truthy(get(c, "id")) {
				continue
			}
			recurring := jsjson.Truthy(get(c, "recurring"))
			schedule := ""
			if s := get(c, "schedule"); s != nil {
				schedule = JSString(s)
			}
			w := db.HookWait{Target: JSString(get(c, "id"))}
			if !recurring {
				w.Until = NextCronFire(schedule, now)
			}
			w.Detail = harnessTimerDetail(recurring, schedule, w.Until, now)
			data := jsjson.NewObject()
			if s, ok := c.Get("schedule"); ok {
				data.Set("schedule", s)
			}
			data.Set("recurring", recurring)
			if s, ok := c.Get("prompt"); ok {
				data.Set("prompt", s)
			}
			d := jsjson.Stringify(data, "")
			w.Data = &d
			timers = append(timers, w)
		}
	}
	return jobs, timers
}

var digits = regexp.MustCompile(`^\d+$`)

// harnessTimerDetail is src/adapters/claude-timer.ts harnessTimerDetail (S-3391): a recurring cron keeps its cron, a
// one-off shows its UTC fire time (with the date when it is a day or more away), and either says it is the harness's
// own timer. schedule is the TS String of c.schedule, with a missing or null one as empty.
func harnessTimerDetail(recurring bool, schedule string, until *string, now time.Time) string {
	if recurring {
		return "harness cron " + schedule
	}
	if until != nil {
		t, _ := time.Parse("2006-01-02T15:04:05.000Z", *until)
		day := ""
		if t.Sub(now) >= 24*time.Hour {
			day = t.Format("01-02") + " "
		}
		return "harness timer at " + day + t.Format("15:04") + "Z"
	}
	return "harness timer " + schedule
}

// NextCronFire is src/adapters/claude-timer.ts nextCronFire: the next time a one-shot cron with a fixed minute and hour fires
// (Claude Code writes ScheduleWakeup and a one-shot CronCreate that way), in this machine's local time; nil for any other
// schedule. JavaScript's setters are followed one by one, as each normalizes what it is given.
func NextCronFire(schedule string, from time.Time) *string {
	f := fieldsOf(schedule)
	field := func(i int) string {
		if i < len(f) {
			return f[i]
		}
		return ""
	}
	min, hour, dom, mon := field(0), field(1), field(2), field(3)
	if !digits.MatchString(min) || !digits.MatchString(hour) {
		return nil
	}
	num := func(s string) int { n, _ := strconv.Atoi(s); return n }
	from = from.Local()
	t := cron.Local(from.Year(), from.Month(), from.Day(), num(hour), num(min))
	if digits.MatchString(mon) {
		day := t.Day()
		if digits.MatchString(dom) {
			day = num(dom)
		}
		t = cron.Local(t.Year(), time.Month(num(mon)), day, t.Hour(), t.Minute())
	} else if digits.MatchString(dom) {
		t = cron.Local(t.Year(), t.Month(), num(dom), t.Hour(), t.Minute())
	}
	if !t.After(from) && !digits.MatchString(dom) {
		t = cron.Local(t.Year(), t.Month(), t.Day()+1, t.Hour(), t.Minute())
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000Z")
	return &s
}

var spaces = regexp.MustCompile(`\s+`)

// fieldsOf is schedule.trim().split(/\s+/).
func fieldsOf(s string) []string { return spaces.Split(jsjson.Trim(s), -1) }

var taskNotice = regexp.MustCompile(`^\s*<task-notification>(?s:.*?)<task-id>([^<]+)</task-id>(?s:.*?)<status>(\w+)</status>`)

// StartedJob is the job a submitted prompt says ended (src/adapters/claude.ts clearStartedWaits): a task notification
// naming its id with a status other than running. ok is false for a prompt that is no task notification, so a timer's
// prompt may match instead; ended is false for a notification of a job still running.
func StartedJob(prompt string) (id string, ended, ok bool) {
	m := taskNotice.FindStringSubmatch(prompt)
	if m == nil {
		return "", false, false
	}
	return jsjson.Trim(m[1]), m[2] != "running", true
}

// FiredTimer is whether a timer hook wait's data says it is the one-shot timer whose prompt this is.
func FiredTimer(data *string, prompt string) bool {
	if data == nil {
		return false
	}
	v, err := jsjson.Parse([]byte(*data))
	o, _ := v.(*jsjson.Object)
	if err != nil || o == nil {
		return false
	}
	return !jsjson.Truthy(get(o, "recurring")) && get(o, "prompt") == prompt
}
