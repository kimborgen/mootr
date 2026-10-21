// Runs src/tmux.ts calls against testdata/fake-tmux, which records every tmux call, for go/internal/tmux's golden test
// (S-2804). The caller puts fake-tmux first on PATH as `tmux` and sets FAKE_TMUX_LOG, STAM_TMUX_SOCKET and TMPDIR. The
// calls come as JSON on stdin, [["newSession", name, cwd, {env}, [argv]], ["sendKeys", name, ...keys], ...]; the
// results of pure calls (shellQuote, attachArgs) go out as JSON.
//
//   node go/internal/tmux/testdata/ts-tmux.mjs < calls.json
import { readFileSync, writeSync } from 'node:fs';

const tmux = await import('../../../../src/tmux.ts');
const out = [];
for (const [fn, ...args] of JSON.parse(readFileSync(0, 'utf8'))) out.push((await tmux[fn](...args)) ?? null);
writeSync(1, JSON.stringify(out));
process.exit(0);
