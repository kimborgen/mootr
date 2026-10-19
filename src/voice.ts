// Voice input: one recorded clip in, its text out, through ElevenLabs Scribe
// (POST /api/voice/transcribe; the prompt input's mic calls it). The clip is forwarded in
// memory and never stored, not on disk and not in the logs.
//
// The key is ELEVENLABS_API_TOKEN in STAM_HOME/voice.env (mode 600), read the way
// src/credits.ts reads opencode.env. It never leaves this file: not in a response, an
// event, or an error message. The endpoint is overridable with STAM_ELEVENLABS_URL so a
// test can stub it.
//
// Cost goes to stam's usage under the `elevenlabs` account, attributed to stam with the
// purpose `voice:transcribe` as the model, so it shows on the Usage page. Scribe bills
// $0.22 per audio hour, and keyterm prompting adds $0.05 per hour when terms are sent.
// A failure never throws into the daemon: transcribe answers an error for the caller.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAM_HOME } from './config.ts';
import * as db from './db.ts';

const base = () => process.env.STAM_ELEVENLABS_URL ?? 'https://api.elevenlabs.io';
const MODEL = 'scribe_v2';
const PURPOSE = 'voice:transcribe';
const ACCOUNT = 'elevenlabs';
const TIMEOUT_MS = 60_000;
// A clip past this is refused before it is read whole into memory.
export const MAX_BYTES = 25 * 1024 * 1024;
const USD_PER_HOUR = 0.22;
const KEYTERM_USD_PER_HOUR = 0.05;
const KEYTERMS_MAX = 100;

export class VoiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The key, or undefined when none is set. Never logged or returned. The file must be a regular
// file with no group or other bits (mode 600); the check runs on the open descriptor, so the file
// read is the file checked. Otherwise voice is off and the event says why.
export function apiKey(): string | undefined {
  let fd: number;
  try {
    fd = openSync(join(STAM_HOME, 'voice.env'), 'r');
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0) {
      fail('voice.env must be mode 600');
      return undefined;
    }
    return readFileSync(fd, 'utf8').match(/^ELEVENLABS_API_TOKEN=(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '') || undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Whether voice is configured: the only thing the UI learns about the key.
export function configured(): boolean {
  return apiKey() !== undefined;
}

// Terms that help Scribe spell the names stam uses: agent names and ITSA keys.
function keyterms(): string[] {
  const names = db.listAgents().map((a) => a.name);
  const keys = db.open().prepare("SELECT key FROM itsas WHERE status NOT IN ('done', 'canceled', 'duplicate', 'wont_do') ORDER BY key").all() as { key: string }[];
  const terms = [...new Set([...names, ...keys.map((k) => k.key)])].filter((t) => t && t.length <= 50);
  return terms.slice(0, KEYTERMS_MAX);
}

// The clip's type as a file extension for the upload's filename; Scribe reads the format from
// the bytes, the name only helps it.
function extension(type: string): string {
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

// Transcribes one clip. Returns the text. Throws VoiceError (status and a message with no
// key in it) for a missing key, a too-large clip, an HTTP error, a timeout, or a body with no
// text; the route turns that into the response.
export async function transcribe(audio: Buffer, contentType: string): Promise<{ text: string }> {
  const key = apiKey();
  if (!key) throw new VoiceError(503, 'voice is not configured: set ELEVENLABS_API_TOKEN in voice.env');
  if (!audio.length) throw new VoiceError(400, 'the request has no audio');
  if (audio.length > MAX_BYTES) throw new VoiceError(413, 'the clip is larger than 25 MB');
  const terms = keyterms();
  const form = new FormData();
  form.append('model_id', MODEL);
  form.append('diarize', 'false');
  for (const t of terms) form.append('keyterms', t);
  const type = contentType || 'audio/webm';
  form.append('file', new Blob([audio], { type }), `clip.${extension(type)}`);
  let res: Response;
  try {
    res = await fetch(`${base()}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    fail(timeout ? 'timeout' : 'network');
    throw new VoiceError(504, timeout ? 'the transcription timed out' : 'could not reach the transcription service');
  }
  if (!res.ok) {
    fail(`HTTP ${res.status}`);
    throw new VoiceError(502, `the transcription service answered HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as any;
  if (typeof data?.text !== 'string') {
    fail('no text in the response');
    throw new VoiceError(502, 'the transcription service sent no text');
  }
  const seconds = audioSeconds(data);
  const cost = (seconds / 3600) * (USD_PER_HOUR + (terms.length ? KEYTERM_USD_PER_HOUR : 0));
  recordCost(cost);
  db.addEvent('stam', 'voice:transcribe', { seconds: Math.round(seconds * 10) / 10, cost, bytes: audio.length, keyterms: terms.length });
  return { text: data.text.trim() };
}

// The clip's length: the response's audio_duration_secs, else where the last word ends.
function audioSeconds(data: any): number {
  if (typeof data.audio_duration_secs === 'number' && Number.isFinite(data.audio_duration_secs)) return data.audio_duration_secs;
  const words = Array.isArray(data.words) ? data.words : [];
  const end = words.length ? Number(words[words.length - 1].end) : 0;
  return Number.isFinite(end) ? end : 0;
}

// One recorded failure: an event with the kind of failure only, never the key or the body.
function fail(error: string): void {
  db.addEvent('stam', 'voice:error', { purpose: PURPOSE, error });
}

// Stam's spend on one transcription: a usage row for the pseudo-agent `stam` on the elevenlabs
// account (same shape as decide.ts), with the purpose as the model.
function recordCost(cost: number): void {
  db.open()
    .prepare(
      `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out)
       VALUES ('stam', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens_in = tokens_in + excluded.tokens_in, model = excluded.model`,
    )
    .run(new Date().toISOString().slice(0, 10), ACCOUNT, PURPOSE, ACCOUNT, cost, 0, 0);
}
