// Draws the app's icons into web/public from an agent's glyph (the bot mark in a state ring)
// and the tokens: coal-800 ground, the dark theme's accent ring (indigo-400), coal-0 mark.
// Run after changing the glyph or those tokens: node scripts/make-icons.mjs
// Needs playwright-core, found where web/check/phone.mjs finds it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumLaunchOptions } from '../web/check/chromium-launch.mjs';
import { findPlaywright } from '../web/check/find-playwright.mjs';

const root = join(import.meta.dirname, '..');
const tokens = readFileSync(join(root, 'web/tokens.css'), 'utf8');
const tok = (name) => tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1];
const bot = readFileSync(join(root, 'web/src/icons.ts'), 'utf8').match(/"bot": "(.*?)",\n/)[1].replace(/\\"/g, '"');

// The ring and mark sit inside the central 80%, a maskable icon's safe zone.
const svg = ({ ground, ring, mark }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${ground ? `<rect width="512" height="512" fill="${ground}"/>` : ''}
<circle cx="256" cy="256" r="148" fill="none" stroke="${ring}" stroke-width="22"/>
<g transform="translate(160 160) scale(8)" fill="none" stroke="${mark}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${bot}</g></svg>`;
const app = svg({ ground: tok('coal-800'), ring: tok('indigo-400'), mark: tok('coal-0') });
// Android draws the badge (status bar) from its alpha only.
const badge = svg({ ring: '#fff', mark: '#fff' });

const { chromium } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage();
const out = join(root, 'web/public');
writeFileSync(join(out, 'icon.svg'), app + '\n');
for (const [name, src, size] of [['icon-192.png', app, 192], ['icon-512.png', app, 512], ['apple-touch-icon.png', app, 180], ['badge-96.png', badge, 96]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${src}`);
  writeFileSync(join(out, name), await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('wrote icons to web/public');
