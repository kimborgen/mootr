#!/usr/bin/env node
// Unit test for src/mail-embed.ts (S-718): a path on this machine named by an embed block or by a
// compare block's before or after line is attached, and the line becomes the attachment's name, so
// the mail shows it; a URL, a missing file, or a relative path stays as it is. Free, no daemon.
// `node --test test/mail-embed.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';
import { embedFiles } from '../src/mail-embed.ts';

const home = tempHome('stam-mail-embed-');
const dir = join(home, 'files');
const before_png = join(dir, 'old.png');
const after_png = join(dir, 'new.png');

before(() => {
  mkdirSync(join(dir, 'a'), { recursive: true });
  mkdirSync(join(dir, 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'shot.png'), 'a');
  writeFileSync(join(dir, 'b', 'shot.png'), 'b');
  writeFileSync(before_png, 'old');
  writeFileSync(after_png, 'new');
});
test('an embed block with an absolute path attaches the file and names it in the block', () => {
  const r = embedFiles({ body: `\`\`\`embed\n${join(dir, 'a', 'shot.png')}\nThe shot.\n\`\`\`` });
  assert.deepEqual(r.attachments, [{ name: 'shot.png', path: join(dir, 'a', 'shot.png') }]);
  assert.equal(r.body, '```embed\nattachment: shot.png\nThe shot.\n```');
});

test('a compare block with absolute paths attaches both images and names them', () => {
  const body = `\`\`\`compare\nBefore: ${before_png}\nAfter: ${after_png}\nThe new layout.\n\`\`\``;
  const r = embedFiles({ body });
  assert.deepEqual(r.attachments, [
    { name: 'old.png', path: before_png },
    { name: 'new.png', path: after_png },
  ]);
  assert.equal(r.body, '```compare\nBefore: old.png\nAfter: new.png\nThe new layout.\n```');
});

test('a URL, a relative path, and a missing file in a compare block stay as they are', () => {
  const body = `\`\`\`compare\nBefore: old.png\nAfter: https://x.test/new.png\nBefore: ${join(dir, 'missing.png')}\n\`\`\``;
  const r = embedFiles({ body });
  assert.deepEqual(r.attachments, []);
  assert.equal(r.body, body);
});

test('two files with the same name get distinct attachment names', () => {
  const r = embedFiles({ body: `\`\`\`compare\nBefore: ${join(dir, 'a', 'shot.png')}\nAfter: ${join(dir, 'b', 'shot.png')}\n\`\`\`` });
  assert.deepEqual(r.attachments.map((a) => a.name), ['shot.png', 'shot-2.png']);
  assert.equal(r.body, '```compare\nBefore: shot.png\nAfter: shot-2.png\n```');
});

test('one file named as both before and after attaches once', () => {
  const r = embedFiles({ body: `\`\`\`compare\nBefore: ${before_png}\nAfter: ${before_png}\n\`\`\`` });
  assert.equal(r.attachments.length, 1);
  assert.equal(r.body, '```compare\nBefore: old.png\nAfter: old.png\n```');
});

test('an unnamed attachment of the same file is named by its path, so an embed block of it shows', () => {
  const r = embedFiles({
    body: `\`\`\`embed\n${after_png}\n\`\`\``,
    attachments: [{ path: after_png }],
  });
  assert.deepEqual(r.attachments, [{ path: after_png }]);
  assert.equal(r.body, '```embed\nattachment: new.png\n```');
});

test('an attachment already on the mail keeps its name, and a new file takes the next free one', () => {
  const r = embedFiles({
    body: `\`\`\`compare\nBefore: old.png\nAfter: ${after_png}\n\`\`\``,
    attachments: [{ name: 'old.png', content_b64: 'eA==' }],
  });
  assert.deepEqual(r.attachments.map((a) => a.name), ['old.png', 'new.png']);
  assert.equal(r.body, '```compare\nBefore: old.png\nAfter: new.png\n```');
});
