// The local embedder's worker thread (S-141): loads the model once, with one intra-op thread so
// it doesn't take the machine, and answers batches of texts with mean-pooled, normalised vectors.
// Concurrent requests share one load, and batches run one at a time.
import { parentPort, workerData } from 'node:worker_threads';

let extractor: Promise<any> | undefined;
let queue: Promise<void> = Promise.resolve();

// Loads the model once: every request during a cold load waits on the same promise.
function load(model: string, revision: string, cache: string): Promise<any> {
  extractor ??= (async () => {
    const { pipeline, env } = await import(workerData.entry);
    env.cacheDir = cache + '/models';
    env.allowRemoteModels = true;
    return pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu', revision, session_options: { intraOpNumThreads: 1 } });
  })();
  return extractor;
}

async function handle({ id, texts, model, revision, cache }: { id: number; texts: string[]; model: string; revision: string; cache: string }) {
  try {
    const run = await load(model, revision, cache);
    const out = await run(texts, { pooling: 'mean', normalize: true });
    const vecs = out.tolist().map((row: number[]) => Float32Array.from(row));
    parentPort!.postMessage({ id, vecs });
  } catch (e) {
    // A failed load is retried by the next request: forget the promise.
    extractor = undefined;
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
}

// One batch at a time: each waits for the one before it.
parentPort!.on('message', (msg) => {
  queue = queue.then(() => handle(msg));
});
