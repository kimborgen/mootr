package tiny

import (
	"context"
	"slices"
	"sync"
)

// lane is the queue src/tool-summaries.ts and src/tool-names.ts share: jobs by key, so one thing is asked once at a
// time; a newer batch's waiting jobs go ahead of older ones; what falls past the end is dropped, to be asked again when
// the view shows it; a few run at once while the step is on.
type lane struct {
	conc, max int
	on        func() bool

	mu      sync.Mutex
	queue   []*job
	jobs    map[string]*job
	running map[*job]context.CancelFunc
	// watch holds, for each key an admission is between peek and add for, how many such admissions there are and how
	// many jobs for the key ended meanwhile, so add can tell that what the admission read may be out of date.
	watch map[string]*watch
}

type watch struct {
	admissions int
	ended      uint64
}

// ticket is one admission's peek: its key and the count of the key's ended jobs then. Hand it to add, and to done.
type ticket struct {
	key   string
	ended uint64
}

// job is one queued or running call. done closes once it ran or was dropped.
type job struct {
	key     string
	run     func(ctx context.Context)
	started bool
	done    chan struct{}
}

func newLane(conc, max int, on func() bool) *lane {
	return &lane{conc: conc, max: max, on: on, jobs: map[string]*job{}, running: map[*job]context.CancelFunc{}, watch: map[string]*watch{}}
}

// get is the job queued or running for key, else a new one made by mk, recorded under key.
func (l *lane) get(key string, mk func() func(ctx context.Context)) *job {
	l.mu.Lock()
	defer l.mu.Unlock()
	if j := l.jobs[key]; j != nil {
		return j
	}
	j := &job{key: key, run: mk(), done: make(chan struct{})}
	l.jobs[key] = j
	return j
}

func (l *lane) drop(j *job) {
	if l.jobs[j.key] == j {
		delete(l.jobs, j.key)
	}
	select {
	case <-j.done:
	default:
		close(j.done)
	}
}

// live is whether j is still the job recorded under its key: get and promote lock apart, so between them another
// request's promote or a stop can drop j, and a later get can record a new job for the key.
func (l *lane) live(j *job) bool {
	select {
	case <-j.done:
		return false
	default:
	}
	return l.jobs[j.key] == j
}

// promote moves the batch's waiting jobs to the queue's front, in the batch's order, and starts what can run. A job
// dropped since its get stays dropped, so one key is never asked twice.
func (l *lane) promote(batch []*job) {
	l.mu.Lock()
	var front []*job
	for _, j := range batch {
		if !j.started && l.live(j) && !slices.Contains(front, j) {
			front = append(front, j)
		}
	}
	if len(front) == 0 {
		l.mu.Unlock()
		return
	}
	queue := front
	for _, j := range l.queue {
		if !slices.Contains(front, j) {
			queue = append(queue, j)
		}
	}
	if len(queue) > l.max {
		for _, j := range queue[l.max:] {
			l.drop(j)
		}
		queue = queue[:l.max]
	}
	l.queue = queue
	l.mu.Unlock()
	go l.pump()
}

// peek is whether a job for key is queued or running, and a ticket that watches the key's jobs ending until done.
func (l *lane) peek(key string) (busy bool, t ticket) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.watch[key]
	if w == nil {
		w = &watch{}
		l.watch[key] = w
	}
	w.admissions++
	return l.jobs[key] != nil, ticket{key, w.ended}
}

// done ends a peek's watch.
func (l *lane) done(t ticket) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if w := l.watch[t.key]; w != nil {
		if w.admissions--; w.admissions == 0 {
			delete(l.watch, t.key)
		}
	}
}

// add queues a job for the ticket's key at the back, as src/mail-title.ts queues its calls, and starts what can run. It
// refuses, queuing nothing, when the step is off (so a stop either clears the job or comes first and refuses it), when
// a job for the key is queued or running, or when the queue is full. stale is true, and nothing is queued, when a job
// for this key ended since the peek: what the caller read of the store before then may be out of date, so it reads
// again. Jobs for other keys ending don't count.
func (l *lane) add(t ticket, run func(ctx context.Context)) (ok, stale bool) {
	l.mu.Lock()
	if w := l.watch[t.key]; w != nil && w.ended != t.ended {
		l.mu.Unlock()
		return false, true
	}
	if !l.on() || l.jobs[t.key] != nil || len(l.queue) >= l.max {
		l.mu.Unlock()
		return false, false
	}
	j := &job{key: t.key, run: run, done: make(chan struct{})}
	l.jobs[t.key] = j
	l.queue = append(l.queue, j)
	l.mu.Unlock()
	go l.pump()
	return true, false
}

func (l *lane) pump() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for len(l.running) < l.conc && len(l.queue) > 0 && l.on() {
		j := l.queue[0]
		l.queue = l.queue[1:]
		j.started = true
		ctx, cancel := context.WithCancel(context.Background())
		l.running[j] = cancel
		go func() {
			j.run(ctx)
			cancel()
			l.mu.Lock()
			delete(l.running, j)
			l.drop(j)
			if w := l.watch[j.key]; w != nil {
				w.ended++
			}
			l.mu.Unlock()
			l.pump()
		}()
	}
}

// stop is the step turned off: nothing queued runs, a job got but not yet promoted is dropped too, and calls in flight
// are canceled.
func (l *lane) stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, j := range l.jobs {
		if !j.started {
			l.drop(j)
		}
	}
	l.queue = nil
	for _, cancel := range l.running {
		cancel()
	}
}

// queued is the waiting jobs' keys, first asked first, for tests.
func (l *lane) queued() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.queue))
	for i, j := range l.queue {
		out[i] = j.key
	}
	return out
}

// wait waits for every job, until the context ends.
func wait(ctx context.Context, jobs []*job) {
	for _, j := range jobs {
		select {
		case <-j.done:
		case <-ctx.Done():
			return
		}
	}
}
