#!/usr/bin/env node
// A stub OpenRouter for the end-to-end cost test (test/e2e-cost.sh), free: `node cost-stub.mjs DIR`
// listens on a free port and writes DIR/url.
//   POST .../decisions  answers like decide-stub.mjs would for a mail check, costing DIR/cost
//                       dollars (0.02 without the file); the cost is added to the key's usage.
//   GET  .../credits    total_credits and total_usage, where total_usage is what decisions have
//                       cost and total_credits leaves DIR/remaining dollars (5 without the file).
//   GET  .../key        a key with no limit of its own; DIR/key-status, when present, is the HTTP
//                       status it answers with instead (a failing error probe).
// Writing DIR/remaining sets the balance the next poll reads, so a test can run credits out and
// top them up again; DIR/count holds the number of /credits calls.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
mkdirSync(dir, { recursive: true });
const num = (file, fallback) => (existsSync(join(dir, file)) ? Number(readFileSync(join(dir, file), 'utf8')) : fallback);
let spent = 0;
let polls = 0;

const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path.endsWith('/decisions')) {
      const cost = num('cost', 0.02);
      spent += cost;
      return void res.end(
        JSON.stringify({
          model: 'microsoft/microsoft-decision-1-stub',
          answers: {
            follows: { type: 'noul', noul: 0.94 },
            concise: { type: 'noul', noul: 0.9 },
            fluff: { type: 'noul', noul: 0.1 },
            value: { type: 'noul', noul: 0.8 },
          },
          usage: { input_tokens: 40, output_tokens: 2, cost },
          id: 'gen-cost-stub',
          provider: 'stub',
        }),
      );
    }
    if (req.method === 'GET' && path.endsWith('/credits')) {
      writeFileSync(join(dir, 'count'), String(++polls));
      return void res.end(JSON.stringify({ data: { total_credits: spent + num('remaining', 5), total_usage: spent } }));
    }
    if (req.method === 'GET' && path.endsWith('/key') && existsSync(join(dir, 'key-status'))) return void res.writeHead(num('key-status', 500)).end('{}');
    if (req.method === 'GET' && path.endsWith('/key')) return void res.end(JSON.stringify({ data: { limit: null, limit_remaining: null } }));
    res.writeHead(404).end('{}');
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(join(dir, 'url'), `http://127.0.0.1:${server.address().port}`));
