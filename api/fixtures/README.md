# Cross-language fixtures

Golden inputs and outputs for the pure TS logic the Go daemon must match byte for byte (S-2386, S-2194).
The outputs come from today's TS code. A Go port of a module reads the same file and checks every case.

## Layout

`api/fixtures/NAME/cases.json`, one folder per module:

| Folder | TS source | Input → output |
| --- | --- | --- |
| `guard` | `src/guard.ts` (the tokenizer behind `isBroadKill`, `guardOutput`) | `{command}` → `{broad}`; with `hook: true`, `{tool_name, command?}` → `{hook}` (the hook's stdout, `""` for no answer) |
| `cron` | `src/waits.ts` `nextCron` | `{spec, from, tz}` → `{next}` or `{error}` |
| `stub-embedder` | `src/embed.ts` `stubVector` (`STAM_EMBEDDER=stub`) | `{text}` → `{dim, idx, val}` |
| `layout-ops` | `src/layout-ops.ts` `apply` | `{start?, ops}` → `{layout}` or `{error, at}` |
| `process-validate` | `src/process-validate.ts` `parseProcessText` | `{yaml, file, knownTypes?, knownStatuses}` → `{process?, errors}` |
| `tool-name-labels` | `src/tool-name-labels.ts` | `{fn, args}` → the function's result (`null` for undefined) |
| `tool-icons` | `src/tool-icons.ts` `toolIcon` | `{harness?, name}` → icon name |
| `system-notice` | `src/mail-notice.ts` `isSystemNotice` | `{from_id?, notice?}` → boolean |

## Format

```json
{
"fixture": "cron",
"cases": [
  {"name": "...", "input": {...}, "output": {...}},
  ...
]
}
```

One case per line, so a diff shows a changed case on one line. `name` is unique in a file. Compare `output` as
parsed JSON (deep equality); key order and whitespace don't matter, array order does. A case with an error
expects the exact message text.

Notes per fixture:

- `cron`: `from` is an ISO instant, `tz` the zone the parser runs in (it works in local time; set `TZ`/the
  location before the call). `next` is the UTC ISO instant with milliseconds (`...:00.000Z`).
- `stub-embedder`: the 256-d vector holds only nonzero entries: `idx[i]` is a dimension and `val[i]` its value
  as a float32 (printed as the shortest float64 that round trips it). Every other dimension is `0`. Compare as
  float32: parse `val` to float32 and require equality with the port's float32 result. An empty vector is
  `idx: [], val: []`.
  `normalise` counts the stems as float32 values, sums their squares and takes the square root in float64, then
  divides each element in float64 and rounds the result to float32. A port must not divide in float32. Hash:
  FNV-1a over the stem's UTF-16 code units, `% 256`; the stub lowercases and splits on `[^a-z0-9]+`, so a
  non-ASCII letter is a separator.
- `layout-ops`: new pane and split ids are made from a counter, `p0`, `p1`, ... in order (an op's own `ids` win);
  the first pane of a world (`defaultWorld`) is always `p_0`. `start`, when present, is the layout to begin from
  (the default is the empty layout). `at` is the index of the op that threw; the layout before it is dropped.
- `process-validate`: `knownTypes`, when absent, means "don't check agent types". `knownStatuses` is a list.
  `errors` is the exact list of message strings.
- `guard`: `command` may hold newlines (heredocs, loops). `output.hook` is compared byte for byte, so the key order
  and the escaping count: Go must marshal with `json.Encoder.SetEscapeHTML(false)` (TS leaves `'`, `<`, `>`, `&`
  as they are) and no trailing newline.
- A case with an `errorPrefix` (the `not valid YAML` case of `process-validate`) holds an error whose text comes
  from a library: compare each error only up to that prefix. In the file, `output.errors` shows the prefix alone.

## How Go tests read them

Each ported module has a Go test that walks `api/fixtures/NAME/cases.json` (found from the test's package
directory with a relative path), decodes `input` into the port's input type and `output` into a
`json.RawMessage`, runs the port, marshals its result, and compares both sides as decoded JSON (floats from
`stub-embedder` at float32). The Go side lands with each module's port, not here.

## TS side

- `test/fixtures-ts.test.mjs` (`test/run.sh fixtures-ts`, daemon-free) runs every case through the TS code, and
  fails if a file differs from what the regen script writes.
- `node scripts/fixtures-regen.mjs [--accept] [NAME...]` rewrites the files. It names the cases it adds, removes or
  changes, and refuses a changed case without `--accept`. Run it when TS behaviour changes on purpose,
  review the diff, and commit it with the Go port's change. The inputs live in `scripts/fixtures-lib.mjs`.
- To add a case: add its input to the module's list in `scripts/fixtures-lib.mjs`, regenerate, read the output.
