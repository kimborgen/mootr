# API contract

`openapi.yaml` is the contract of the stam daemon's HTTP API (S-2194 plan, section 3). It describes what the
TypeScript daemon does today. Rules: closed enums, `additionalProperties: false` on every object except
`fields`-style maps, explicit `nullable`, one error schema. A shape that breaks a rule is kept and marked
`x-legacy`; a field dropped on purpose is listed under `x-removed` with its ITSA.

Layout: `paths/` one path item per file, `schemas/` one schema per file (named in `openapi.yaml`).

## Generated files (committed)

| File | Made by | Run on |
|---|---|---|
| `api/openapi.bundled.yaml` | `node scripts/api-gen.mjs` | anywhere |
| `web/src/api/types.gen.ts` | `node scripts/api-gen.mjs` (openapi-typescript) | anywhere |
| `go/internal/api/api.gen.go` | `node scripts/api-gen.mjs --go` (oapi-codegen, pinned in the script) | **storage only**: Go never builds on the gate machine |

`--check` fails when a file is stale. `test/run.sh api-gen` checks the first two on every machine;
`go/api-check.sh` (`--go --check`, called from `go/check.sh` in the `go` gate) checks the Go file and fails
when the generator fails.

## Contract test

`test/run.sh openapi-contract` starts a throwaway TS daemon, calls the specced routes and validates status and
body with ajv. Add a route to the spec and to nothing else: the test walks `paths`.
`go/contract.sh` (in the `go` gate, storage only) runs the same check on the Go daemon, over a test home whose
`stam.db` the TS `src/db.ts` seeds (`go/internal/server/testdata/seed.mjs`), since the Go daemon can't spawn yet.
