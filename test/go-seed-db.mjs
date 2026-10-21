// Creates STAM_HOME/stam.db with the TypeScript schema (src/db.ts), for a Go daemon that refuses to create one
// (S-2297, S-2194). test/lib.sh runs it before it starts the Go daemon in a test home; the TS daemon makes its own.
// It never touches the live home.
import { LIVE_HOME } from '../src/config.ts';

if (LIVE_HOME) {
  console.error('go-seed-db: refusing the live home');
  process.exit(1);
}
const { open } = await import('../src/db.ts');
open().close();
