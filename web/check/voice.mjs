// Browser checks of the prompt input's mic button (S-73), deterministic: the microphone
// (getUserMedia and MediaRecorder) and the transcribe route are stubbed, so no audio or model
// runs. Run through run.sh, which starts a throwaway daemon:
//   web/check/run.sh voice            (OUT=/tmp/voice-shots to keep the screenshots)
// Covers: the button shows only when voice is configured; a tap starts and the next tap stops;
// a hold records until release; Alt+V; Esc discards; a denied microphone shows a message and
// keeps the draft; the transcript lands at the caret, spaced, and is never sent; the tracks stop.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node voice.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });

const { chromium, devices } = findPlaywright();
const u = new URL(base);
const origin = u.origin;
const hash = u.hash;

const browser = await chromium.launch(chromiumLaunchOptions());
const results = [];
let failed = 0;
const check = (tag, name, ok, detail = '') => {
  results.push({ tag, name, ok });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 300) : ''}`);
};

// The stand-ins, injected before the page's own scripts. A clip is one small Blob; the stop
// counter shows the tracks were released.
const STUB = () => {
  window.__stops = 0;
  window.__deny = false;
  const track = { stop() { window.__stops++; } };
  class FakeRecorder {
    constructor() {
      // A recorder that can't be built, after the mic was granted (the check releases the tracks).
      if (window.__recFail) throw new Error('recorder unavailable');
      this.state = 'inactive'; this.mimeType = 'audio/webm';
    }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; setTimeout(() => this.ondataavailable?.({ data: new Blob(['clip'], { type: 'audio/webm' }) }), 0); }
    stop() { this.state = 'inactive'; setTimeout(() => this.onstop?.(), 0); }
  }
  window.MediaRecorder = FakeRecorder;
  delete window.AudioContext; delete window.webkitAudioContext;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => {
      if (window.__deny) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
      return { getTracks: () => [track] };
    },
  } });
};

async function session(tag, device, viewport, { configured = true } = {}) {
  const ctx = await browser.newContext({ ...device, viewport, colorScheme: 'light' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, 'light');
  await ctx.addInitScript(STUB);
  const transcribes = [];
  // The transcribe answer waits for the test, so the Transcribing state can be seen.
  let open;
  const gate = new Promise((res) => { open = res; });
  await ctx.route(`${origin}/api/voice`, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured }) }));
  await ctx.route(`${origin}/api/voice/transcribe`, async (r) => {
    transcribes.push(r.request().headers()['content-type']);
    await gate;
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: 'hello from the clip' }) });
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check(tag, 'no page errors', false, e.message));
  await p.goto(origin + '/' + hash);
  // The bottom prompt input writes to the open agent's pane: open one (the seeded daemon has them).
  const token = new URLSearchParams(hash.slice(1)).get('token') ?? '';
  const agents = await fetch(origin + '/api/agents', { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } }).then((r) => r.json());
  const agent = agents.find((a) => a.kind === 'agent') ?? agents.find((a) => a.kind !== 'assistant');
  await p.waitForFunction(() => !!window.stamDebug);
  await p.waitForTimeout(1500); // the app loads its agents before a pane can open
  await p.evaluate((id) => window.stamDebug.selectAgent(id), agent.id);
  await p.locator('#w-bottom .composer textarea:not([disabled])').first().waitFor();
  return { ctx, p, transcribes, open };
}

const shot = async (p, name) => { await p.waitForTimeout(300); await p.screenshot({ path: `${out}/${name}.png` }); };
const box = (p) => p.locator('#w-bottom .cmp-box');
const mic = (p) => p.locator('#w-bottom .cmp-mic');
const ta = (p) => p.locator('#w-bottom .cmp-box textarea');
const voiceRow = (p) => p.locator('#w-bottom .cmp-voice');

async function flows(tag, device, viewport) {
  const { ctx, p, transcribes, open } = await session(tag, device, viewport);
  const step = async (name, fn) => { try { await fn(); } catch (e) { check(tag, name, false, e.message.split('\n')[0]); } };
  await step('the mic button shows when voice is configured', async () => {
    await mic(p).waitFor({ state: 'visible' });
    check(tag, 'the mic button shows when voice is configured', true);
  });
  await step('idle: the mic is idle and the box is empty', async () => {
    await ta(p).fill('');
    check(tag, 'idle: no recording row', (await voiceRow(p).count()) === 0);
    await shot(p, `voice-idle-${tag}`);
  });
  await step('a tap starts, the next tap stops', async () => {
    await ta(p).fill('Please ');
    await ta(p).focus();
    await mic(p).click();
    await p.locator('#w-bottom .cmp-mic.rec').waitFor();
    check(tag, 'a tap starts recording: the button shows the recording state', true);
    await p.locator('#w-bottom .cmp-timer').waitFor();
    await shot(p, `voice-recording-${tag}`);
    const track = await p.locator('#w-bottom .cmp-level-track').evaluate((el) => getComputedStyle(el).maxWidth);
    check(tag, 'the level bar keeps its 240px cap from the size token', track === '240px', track);
    await mic(p).click();
    await voiceRow(p).getByText('Transcribing', { exact: false }).waitFor();
    await shot(p, `voice-transcribing-${tag}`);
    open();
    await p.waitForFunction(() => document.querySelector('#w-bottom .cmp-box textarea')?.value.includes('hello from the clip'));
    const v = await ta(p).inputValue();
    check(tag, 'the transcript lands at the caret, spaced after the draft', v === 'Please hello from the clip', JSON.stringify(v));
    check(tag, 'the draft is not sent: the text stays in the box', v.includes('hello from the clip'));
    check(tag, 'the clip goes up with its own content type', transcribes.length === 1 && transcribes[0].startsWith('audio/webm'), transcribes.join(','));
    check(tag, 'the mic tracks were stopped', await p.evaluate(() => window.__stops) >= 1);
  });
  await step('a hold records until release', async () => {
    await ta(p).fill('');
    const b = await mic(p).boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.locator('#w-bottom .cmp-mic.rec').waitFor();
    await p.waitForTimeout(350);
    await p.mouse.up();
    await p.waitForFunction(() => document.querySelectorAll('#w-bottom .cmp-mic.rec').length === 0);
    await p.waitForFunction(() => document.querySelector('#w-bottom .cmp-box textarea')?.value.includes('hello from the clip'));
    check(tag, 'a hold records until release and inserts the transcript', true);
  });
  await step('Esc discards the recording without transcribing', async () => {
    const before = transcribes.length;
    await ta(p).fill('keep me');
    await mic(p).click();
    await p.locator('#w-bottom .cmp-mic.rec').waitFor();
    await ta(p).press('Escape');
    await p.waitForFunction(() => document.querySelectorAll('#w-bottom .cmp-mic.rec').length === 0);
    await p.waitForTimeout(100);
    check(tag, 'Esc discards: no transcribe call, the draft is kept', transcribes.length === before && (await ta(p).inputValue()) === 'keep me');
  });
  await step('Esc discards with focus on the mic button', async () => {
    const before = transcribes.length;
    await ta(p).fill('keep me too');
    await mic(p).click();
    await p.locator('#w-bottom .cmp-mic.rec').waitFor();
    await mic(p).focus();
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => document.querySelectorAll('#w-bottom .cmp-mic.rec').length === 0);
    await p.waitForTimeout(100);
    check(tag, 'Esc with focus on the mic discards: no transcribe call, the draft is kept', transcribes.length === before && (await ta(p).inputValue()) === 'keep me too');
  });
  await step('a recorder that fails to start releases the mic and shows a message', async () => {
    await ta(p).fill('still here');
    const stops = await p.evaluate(() => window.__stops);
    await p.evaluate(() => { window.__recFail = true; });
    await mic(p).click();
    await voiceRow(p).getByText('Could not start the microphone', { exact: false }).waitFor();
    await p.evaluate(() => { window.__recFail = false; });
    const released = (await p.evaluate(() => window.__stops)) > stops;
    check(tag, 'a failed start releases the mic tracks', released);
    check(tag, 'a failed start keeps the draft and shows no recording', (await ta(p).inputValue()) === 'still here' && (await p.locator('#w-bottom .cmp-mic.rec').count()) === 0);
  });
  await step('Alt+V toggles recording', async () => {
    await ta(p).fill('');
    await ta(p).focus();
    await p.keyboard.press('Alt+KeyV');
    await p.locator('#w-bottom .cmp-mic.rec').waitFor();
    await p.keyboard.press('Alt+KeyV');
    await p.waitForFunction(() => document.querySelector('#w-bottom .cmp-box textarea')?.value.includes('hello from the clip'));
    check(tag, 'Alt+V starts and stops, and the transcript lands', true);
  });
  await step('a denied microphone shows a message and keeps the draft', async () => {
    await ta(p).fill('my draft');
    await p.evaluate(() => { window.__deny = true; });
    await mic(p).click();
    await voiceRow(p).getByText('Microphone access is blocked', { exact: false }).waitFor();
    check(tag, 'a denied microphone shows a short message', true);
    check(tag, 'the draft is intact after the denial', (await ta(p).inputValue()) === 'my draft');
    await shot(p, `voice-denied-${tag}`);
    await p.evaluate(() => { window.__deny = false; });
  });
  await ctx.close();

  const off = await session(tag + '-off', device, viewport, { configured: false });
  await off.p.locator('#w-bottom .cmp-box').waitFor();
  check(tag, 'no mic button when voice is not configured', (await off.p.locator('#w-bottom .cmp-mic').count()) === 0);
  await off.ctx.close();
}

const PHONE = { ...devices['Pixel 7'] };
await flows('360', PHONE, { width: 360, height: 740 });
await flows('desktop', {}, { width: 1280, height: 800 });
await browser.close();
const passed = results.length - failed;
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
