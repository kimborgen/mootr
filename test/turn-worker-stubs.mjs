// Stand-in turn readers for test/turn-harden.test.mjs: the worker answers, hangs, or crashes by its
// first request's file name.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (req) => {
  if (req.file === 'hang') return;
  if (req.file === 'crash') throw new Error('boom');
  parentPort.postMessage({ id: req.id, messages: [], cut: false, read: 0, size: 0, truncated: false });
});
