// Short random row ids: a one-letter prefix and four letters or digits (about 1M per prefix).
// A draw can hit an id already in the table, so a caller picks one with freshId inside the
// write transaction, where nothing else can take the id between the check and the insert.
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const ID_TRIES = 20;

export function randomId(prefix: string): string {
  return prefix + [...randomBytes(4)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

// The draw is a seam for tests, which force a collision without waiting on chance.
export const idSource = { draw: randomId };

// A draw `taken` does not hold; a clear error after ID_TRIES (a table near full), never a
// UNIQUE failure from the insert and never an overwrite.
export function freshId(prefix: string, taken: (id: string) => boolean, what: string): string {
  for (let i = 0; i < ID_TRIES; i++) {
    const id = idSource.draw(prefix);
    if (!taken(id)) return id;
  }
  throw new Error(`could not pick a free ${what} id in ${ID_TRIES} tries; the id space (${prefix} + 4 characters) is nearly full`);
}
