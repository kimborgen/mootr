#!/usr/bin/env node
// S-4198: src/compress.ts acceptedEncoding over the Accept-Encoding headers on stdin (a JSON list; null for no header).
// Prints the encodings it picks, "" for none, as a JSON list.
import { readFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { acceptedEncoding } = await import(new URL('src/compress.ts', root));
const headers = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(headers.map((h) => acceptedEncoding({ headers: h === null ? {} : { 'accept-encoding': h } }) ?? '')));
