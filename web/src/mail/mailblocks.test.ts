// @vitest-environment jsdom
// Tests for the mail components. The snapshots were recorded while this module's output was
// identical to the plain-JavaScript renderer it replaced (web/mailblocks.js, removed after
// the React port), so they hold that parity.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as mb from './mailblocks';

const F = '```';
const E = '\x1b';
const mention = (name: string) => (name === 'lead' ? '<a href="#" class="mention" data-open-agent="a1">lead</a>' : null);

beforeAll(() => {
  mb.configure({ mention, itsa: (key) => (key === 'S-12' ? '<a href="#" class="itsalink" data-open-itsa="i12">S-12</a>' : null) });
});

const BODIES: Record<string, string> = {
  decision: `TLDR: Pick the token lifetime.

${F}decision
How long should SSO tokens live?
- 1 hour: safest, users re-login daily (recommended)
- **12 hours** — one login per workday
- Never
${F}

${F}yesno
Run the full e2e suite for about $14? (recommended: yes)
${F}`,
  pick: `${F}pick\nWhich checks?\n- Lint: fast (recommended)\n- Types\n- E2E: slow\n${F}\n\n${F}rank\nOrder the work\n- Auth: first\n- Billing\n- Search (recommended)\n${F}`,
  callout: '> [!DONE]\n> Merged **and** deployed.\n\n> [!BLOCKED]\n> Waiting on `storage`.\n\n> [!NOTE]\n> plain',
  metrics: `${F}metrics\nTests: 214/214 — all green [success]\nSpent: $0.42\nLatency: 1.2 s [warning]\nbroken line\n${F}`,
  table: `${F}table\ntitle: Agents\nname,tokens,cost\nlead,"1,200",$1.50 [success]\nbuilder,300,$0.20 [error]\nplain,—,-\n${F}\n\n| a | b |\n|---|---|\n| 1 | x |\n| 22 | y |`,
  longTable: `${F}csv\nn,v\n${Array.from({ length: 25 }, (_, i) => `r${i},${i * 3}`).join('\n')}\n${F}`,
  checklist: `${F}checklist\n- [x] done thing\n- [~] in progress\n- [ ] next\n- [!] blocked\n- [-] skipped\n- bare item\n${F}`,
  diff: `${F}diff\ndiff --git a/src/config.ts b/src/config.ts\nindex 1..2 100644\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -11,9 +11,13 @@ export const MACHINE\n+// Private to the user\n export function agentDir(id: string): string {\n-  mkdirSync(dir, { recursive: true });\n+  mkdirSync(dir, { recursive: true, mode: 0o700 });\n }\n${F}`,
  terminal: `${F}terminal\n$ stat -c '%a %n' agents\n${E}[33m775${E}[0m agents\n${E}[1;32mquick${E}[0m ${E}[2m(3.1s)${E}[0m ${E}[38;5;12mskip${E}[0m ${E}[41;97mhi${E}[0m <b>\n${F}`,
  tests: `${F}tests\n18 passed\nFAIL e2e-codex > spawns\n  exited 1: refusing\n  at test/e2e-codex.sh:41\nFAIL bare\nPASS e2e-m2 > mails\nSKIP later\nsome note\n${F}`,
  spend: `${F}spend\nFor: Codex e2e\nSpent: $4.20\nBudget: $10\nEstimate: $14\n${F}`,
  error: `${F}error\nMessage: codex app-server: refusing\nWhere: \`config.ts\`\nCause: mode 0775.\nFix: use 0700.\n${F}`,
  progress: `${F}progress\n3/5 Build\n60% Review\nDeploy: 1/4\n${F}`,
  timeline: `${F}timeline\n10:02 — started\n10:09 | built [success]\n2026-10-11 10:15 deploy failed [error]\nno time here\n${F}`,
  compare: `${F}compare\nBefore: old.png\nAfter: https://example.com/new.png\nThe new layout.\n${F}`,
  pane: `${F}pane\n@lead\n${F}\n\n${F}pane\nghost\ncaptured: 2020-01-01T00:00:00Z\n---\n${E}[32mhello${E}[0m\n${F}`,
  embed: `${F}embed\nhttps://youtu.be/dQw4w9WgXcQ?t=42\nA video\n${F}\n\n${F}image\nhttps://example.com/a.png\n${F}\n\n${F}file\nattachment: notes.md\n${F}\n\n${F}embed\n/home/x/file.txt\n${F}\n\nhttps://vimeo.com/12345\n\nhttps://example.com/page`,
  math: `Inline \\(a^2+b^2\\) and price $5 and $6.\n\n$$\nE = mc^2\n$$\n\n${F}math\n\\int_0^1 x\\,dx\n${F}`,
  chart: `${F}chart\ntype: bar\ntitle: Usage\nunit: $\nWeek,Claude Code,Codex\nW1,1.5,2\nW2,3,1\n${F}\n\n${F}mermaid\ngraph TD; A-->B\n${F}`,
  mentions: 'Ask @lead about m3228ca5, or @nobody. See [thread](#m3228ca5) and `m3228ca5` in code.\n\n<details><summary>More</summary>\n\nHidden **text**\n\n</details>',
  code: `${F}ts\nconst x = 1;\n${F}\n\n${F}\nplain block\n${F}\n\n[link](https://example.com)`,
  plain: '',
};

describe('text helpers', () => {
  it('splitTldr', () => {
    expect(mb.splitTldr('TLDR: all good\nrest here')).toEqual({ tldr: 'all good', rest: 'rest here' });
    expect(mb.splitTldr('**TL;DR** fine **\nx')).toEqual({ tldr: 'fine', rest: 'x' });
    expect(mb.splitTldr('no tldr\nline')).toEqual({ tldr: null, rest: 'no tldr\nline' });
    expect(mb.splitTldr(null)).toEqual({ tldr: null, rest: '' });
  });

  it('parseDecision: options', () => {
    const d = mb.parseDecision('Which?\n- A: because (recommended)\n  more why\n- **B** — other\n- C');
    expect(d.yesno).toBe(false);
    expect(d.question).toBe('Which?');
    expect(d.options).toEqual([
      { label: 'A', why: 'because more why', rec: true },
      { label: 'B', why: 'other', rec: false },
      { label: 'C', why: '', rec: false },
    ]);
  });

  it('parseDecision: yes or no', () => {
    const d = mb.parseDecision('Ship it? (recommended: no)');
    expect(d.yesno).toBe(true);
    expect(d.question).toBe('Ship it?');
    expect(d.options.map((o) => [o.label, o.rec])).toEqual([['Yes', false], ['No', true]]);
  });

  it('answer texts', () => {
    expect(mb.choiceText('A')).toBe('Chose **A**.');
    expect(mb.pickText(['A', 'B'])).toBe('Picked **A**, **B**.');
    expect(mb.rankText(['A', 'B'])).toBe('Ranked: 1. **A**, 2. **B**.');
    expect(mb.deferText()).toBe("Deferring this one: still open, I'll decide later. Keep working on what doesn't depend on it.");
    expect(mb.noteText('Both, A first.')).toBe('Note: Both, A first.');
    const d = document.createElement('div');
    d.innerHTML = '<div class="mb-q">First line\nsecond</div>';
    expect(mb.questionOf(d)).toBe('First line');
    expect(mb.answerText(d, 'Chose **A**.')).toBe('> First line\n\nChose **A**.');
    expect(mb.answerText(document.createElement('div'), 'x')).toBe('x');
  });

  it('num', () => {
    expect(mb.num('1,200')).toBe(1200);
    expect(mb.num('$4.20')).toBe(4.2);
    expect(mb.num('−3')).toBe(-3);
    expect(mb.num('2k')).toBe(2000);
    expect(mb.num('1.5M')).toBe(1.5e6);
    expect(mb.num('3 GB')).toBe(3);
    expect(mb.num('60%')).toBe(60);
    expect(mb.num('abc')).toBeNull();
    expect(mb.num(undefined)).toBeNull();
  });

  it('embedUrl', () => {
    expect(mb.embedUrl('https://youtu.be/abc123?t=42')).toEqual({ kind: 'frame', src: 'https://www.youtube-nocookie.com/embed/abc123?start=42', ratio: '16 / 9', site: 'YouTube' });
    expect(mb.embedUrl('https://www.youtube.com/watch?v=xyz')?.src).toBe('https://www.youtube-nocookie.com/embed/xyz');
    expect(mb.embedUrl('https://vimeo.com/123')?.site).toBe('Vimeo');
    expect(mb.embedUrl('https://docs.google.com/presentation/d/AB-1/edit')).toMatchObject({ ratio: '16 / 9', site: 'Google Docs' });
    expect(mb.embedUrl('https://example.com/a.PNG')).toEqual({ kind: 'image', src: 'https://example.com/a.PNG', site: 'example.com' });
    expect(mb.embedUrl('https://example.com/doc.pdf')?.kind).toBe('pdf');
    expect(mb.embedUrl('https://example.com/page')?.kind).toBe('link');
    expect(mb.embedUrl('not a url')).toBeNull();
  });

  it('embedUrl refuses every scheme but http and https (S-1529)', () => {
    for (const u of ['javascript:alert(1)//x.pdf', 'data:application/pdf;base64,AAAA', 'ftp://example.com/a.pdf', 'file:///etc/passwd.pdf', 'vbscript:x']) expect(mb.embedUrl(u)).toBeNull();
    const html = mb.renderMail('```embed\njavascript:alert(1)//a.pdf\n```\n\n```embed\ndata:application/pdf;base64,AAAA\n```');
    expect(html).not.toMatch(/href="(javascript|data):/i);
    expect(html).not.toMatch(/data-frame="(javascript|data):/i);
  });

  it('preview', () => {
    expect(mb.preview('TLDR: **Done** now\nbody')).toBe('Done now');
    expect(mb.preview('Text\n```decision\nPick one?\n- A\n- B\n```\n> [!NOTE]\n> x')).toBe('Text Pick one? x');
    expect(mb.preview('x'.repeat(300), 10)).toBe('xxxxxxxxxx');
  });

  it('compareRefs and shownAttachments', () => {
    const body = '```compare\nBefore: a.png\nAfter: https://x.test/b.png\n```\n```embed\nattachment: c.pdf\n```\n```file\nattachment: d.txt\n```';
    expect([...mb.compareRefs(body)]).toEqual(['a.png', 'https://x.test/b.png']);
    expect([...mb.shownAttachments(body)]).toEqual(['a.png', 'https://x.test/b.png', 'c.pdf', 'd.txt']);
    expect(mb.compareRefs(null).size).toBe(0);
  });

  // Nothing else loads a compared image, so resolveCompare sets its src (2026-10-11: they
  // showed blank after the React port).
  it('resolveCompare points images at their attachments', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('```compare\nBefore: a.png\nAfter: https://x.test/b.png\n```\n```compare\nBefore: gone.png\nAfter: a.png\n```');
    mb.resolveCompare(el, (n) => (n === 'a.png' ? '/api/mail/m1/attachments/a.png?token=t' : null));
    const [one, two] = el.querySelectorAll('.mb-compare');
    expect([...one.querySelectorAll('img')].map((i) => i.getAttribute('src')).sort()).toEqual(['/api/mail/m1/attachments/a.png?token=t', 'https://x.test/b.png']);
    expect(two.classList.contains('missing')).toBe(true);
  });
});

describe('renderMail', () => {
  // Pane snapshots say how long ago they were captured; pin the clock so they don't drift.
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T12:00:00Z')); });
  afterAll(() => { vi.useRealTimers(); });
  it('renders a decision', () => {
    const html = mb.renderMail(BODIES.decision);
    expect(html).toContain('class="mb-tldr"');
    expect(html).toContain('data-choose="1 hour"');
    expect(html).toContain('<span class="mb-rec">Recommended</span>');
    expect(html).toContain('mb-decision yesno');
  });

  it('renders a callout', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail(BODIES.callout);
    expect([...el.querySelectorAll('.mb-callout')].map((c) => c.className)).toEqual(['mb-callout success', 'mb-callout error', 'mb-callout note']);
  });

  it('opens links in a new tab', () => {
    expect(mb.renderMail('[x](https://example.com)')).toContain('target="_blank"');
  });

  it('sorts and folds tables', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail(BODIES.longTable);
    expect(el.querySelector('.mb-table')?.classList.contains('folded')).toBe(true);
    const th = el.querySelector<HTMLElement>('th[data-sort="1"]')!;
    expect(mb.handleClick({ target: th })).toBe(true);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    expect(el.querySelector('.mb-table')?.classList.contains('folded')).toBe(false);
  });

  it('marks decisions answered', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('```decision\nWhich?\n- A\n- B\n```');
    mb.markDecisions(el, { created_at: '1' }, [{ from_id: 'human', created_at: '2', body: '> Which?\n\nChose **B**.' }], true);
    expect(el.querySelector('.mb-decision')?.classList.contains('answered')).toBe(true);
    expect(el.querySelector('.mb-status')?.textContent).toBe('You chose B.');
  });

  it('shows a decision deferred by the new and the old reply, with its buttons still live', () => {
    for (const reply of ["Deferring this one: still open, I'll decide later.", 'Deferring this one. Go with your recommendation, **A**, for now.']) {
      const el = document.createElement('div');
      el.innerHTML = mb.renderMail('```decision\nWhich?\n- A\n- B\n```');
      mb.markDecisions(el, { created_at: '1' }, [{ from_id: 'human', created_at: '2', body: `> Which?\n\n${reply}` }], true);
      expect(el.querySelector('.mb-decision')?.classList.contains('answered')).toBe(false);
      expect(el.querySelector('.mb-status')?.textContent).toBe('You deferred this; it stays open.');
      for (const o of el.querySelectorAll<HTMLButtonElement>('[data-choose]')) expect(o.disabled).toBe(false);
    }
  });

  it('answers a deferred decision when a later reply chooses', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('```decision\nWhich?\n- A\n- B\n```');
    mb.markDecisions(el, { created_at: '1' }, [
      { from_id: 'human', created_at: '2', body: "> Which?\n\nDeferring this one: still open, I'll decide later." },
      { from_id: 'human', created_at: '3', body: '> Which?\n\nChose **B**.' },
    ], true);
    expect(el.querySelector('.mb-decision')?.classList.contains('answered')).toBe(true);
    expect(el.querySelector('.mb-status')?.textContent).toBe('You chose B.');
  });

  it('shows a note alongside a deferral as answered, for a decision and a rank block', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('```decision\nWhich?\n- A\n- B\n```\n\n```rank\nOrder?\n- X\n- Y\n```');
    mb.markDecisions(el, { created_at: '1' }, [{ from_id: 'human', created_at: '2', body: "> Which?\n\nDeferring this one: still open, I'll decide later.\n\n> Order?\n\nDeferring this one: still open, I'll decide later.\n\nNote: Both." }], true);
    for (const b of el.querySelectorAll('.mb-decision')) {
      expect(b.classList.contains('answered')).toBe(true);
      expect(b.querySelector('.mb-status')?.textContent).toBe('You answered with a note.');
    }
  });

  it('keeps a deferred rank block open for its buttons', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('```rank\nOrder?\n- X\n- Y\n```');
    mb.markDecisions(el, { created_at: '1' }, [{ from_id: 'human', created_at: '2', body: "> Order?\n\nDeferring this one: still open, I'll decide later." }], true);
    expect(el.querySelector('.mb-decision')?.classList.contains('answered')).toBe(false);
    expect(el.querySelector('.mb-status')?.textContent).toBe('You deferred this.');
  });

  it('marks a decision answered by a note alone', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('```decision\nWhich?\n- A\n- B\n```\n\n```rank\nOrder?\n- X\n- Y\n```');
    mb.markDecisions(el, { created_at: '1' }, [{ from_id: 'human', created_at: '2', body: '> Which?\n\nNote: Both.\n\n> Order?\n\nNote: Neither.' }], true);
    for (const b of el.querySelectorAll('.mb-decision')) {
      expect(b.classList.contains('answered')).toBe(true);
      expect(b.querySelector('.mb-status')?.textContent).toBe('You answered with a note.');
    }
  });

  it('links known ITSA keys in running text, not in code, links, or longer tokens', () => {
    const el = document.createElement('div');
    el.innerHTML = mb.renderMail('S-12 is done; see S-12, (S-12) and S-99.\n\n`S-12` and [S-12](https://example.com) stay plain, as do XS-12, S-12-b and S-123.\n\n```\nS-12\n```');
    const links = [...el.querySelectorAll<HTMLElement>('a[data-open-itsa]')];
    expect(links.map((a) => a.dataset.openItsa)).toEqual(['i12', 'i12', 'i12']);
    expect(el.querySelector('code')?.querySelector('a')).toBeNull();
    expect(el.querySelector('pre')?.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('S-99');
  });

  it('links an ITSA key in a short inline text such as a subject', () => {
    expect(mb.linkItsaKeys('Review <code>S-12</code> and S-12')).toBe('Review <code>S-12</code> and <a href="#" class="itsalink" data-open-itsa="i12">S-12</a>');
  });

  for (const [name, body] of Object.entries(BODIES)) {
    it(`matches the legacy output: ${name}`, () => {
      expect(mb.renderMail(body)).toMatchSnapshot();
    });
  }

  it('matches the legacy output for the helpers', () => {
    const body = Object.values(BODIES).join('\n\n');
    expect({ preview: mb.preview(body), shown: [...mb.shownAttachments(body)], num: ['1,200', '$4.20', '−3', '2k', 'x', '', '60%', '3 GB'].map(mb.num) }).toMatchSnapshot();
  });
});

describe('mail links', () => {
  it('point at the one mail they name, written in text or as a link', () => {
    const div = document.createElement('div')
    div.innerHTML = mb.renderMail('See m3228ca5, or [that mail](#m9f0c1d2).')
    expect([...div.querySelectorAll<HTMLElement>('[data-thread-link]')].map((a) => a.dataset.threadLink)).toEqual(['m3228ca5', 'm9f0c1d2'])
  })
})

describe('reference links in mail', () => {
  it('drop reference data a mail forges in its own HTML', () => {
    const div = document.createElement('div')
    div.innerHTML = mb.renderMail(`<a class="reflink" data-ref-pick='[{"url":"javascript:alert(1)"}]' data-ref-act="itsa:x">x</a>`)
    expect(div.querySelector('[data-ref-pick], [data-ref-act]')).toBeNull()
  })
})

describe('diff rows (S-2099)', () => {
  const rows = (patch: string) => { const d = document.createElement('div'); d.innerHTML = mb.renderMail(`${F}diff\n${patch}\n${F}`); return d; };
  const copy = (d: HTMLElement) => Array.from(d.querySelectorAll('.l')).map((l) => l.textContent).join('\n');

  it('counts a tab as 4 columns of indent', () => {
    const l = rows('--- a/x\n+++ b/x\n@@ -1 +1 @@\n+\t\tdeep\n+  two').querySelectorAll<HTMLElement>('.l');
    expect(l[1].style.getPropertyValue('--ind')).toBe('8');
    expect(l[2].style.getPropertyValue('--ind')).toBe('2');
    expect(l[0].style.getPropertyValue('--ind')).toBe('0');
  });
  it('keeps file headers out of the rows', () => {
    const d = rows('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b');
    expect(copy(d)).toBe('@@ -1 +1 @@\n-a\n+b');
  });
  it('keeps empty changed lines and puts the marker in its own span', () => {
    const d = rows('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n+\n-\n ctx');
    const l = d.querySelectorAll('.l');
    expect(l[1].textContent).toBe('+');
    expect(l[1].querySelector('.m')?.textContent).toBe('+');
    expect(l[2].textContent).toBe('-');
    expect(l[3].textContent).toBe(' ctx');
  });
  it('escapes markup and survives long tokens', () => {
    const long = 'x'.repeat(500);
    const d = rows(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n+<img src=x onerror=alert(1)>${long}`);
    expect(d.querySelector('img')).toBeNull();
    expect(d.querySelectorAll('.l')[1].textContent).toBe(`+<img src=x onerror=alert(1)>${long}`);
  });
  it('copies back the exact patch lines', () => {
    const patch = '@@ -1,3 +1,3 @@\n context\n-\told\n+\tnew <b>\n ünï';
    expect(copy(rows(`--- a/x\n+++ b/x\n${patch}`))).toBe(patch);
  });
});

describe('diff block (S-2100)', () => {
  const block = (patch: string) => { const d = document.createElement('div'); d.innerHTML = mb.renderMail(`${F}diff\n${patch}\n${F}`); return d; };
  const many = (files: number, rows: number) => Array.from({ length: files }, (_, i) => `diff --git a/f${i} b/f${i}\n--- a/f${i}\n+++ b/f${i}\n@@ -1 +1 @@\n${Array.from({ length: rows - 1 }, (_, j) => `+l${j}`).join('\n')}`).join('\n');

  it('opens every file when the diff fits the phone cap', () => {
    const d = block(many(3, 6));
    expect(d.querySelectorAll('details.mb-file[open]').length).toBe(3);
  });
  it('opens only the first file when it does not', () => {
    const d = block(many(4, 6));
    const f = Array.from(d.querySelectorAll('details.mb-file'));
    expect(f.map((x) => x.hasAttribute('open'))).toEqual([true, false, false, false]);
  });
  it('puts the counts header beside the folds, never inside a summary', () => {
    const d = block(many(2, 4));
    expect(d.querySelector('.mb-dhead .mb-dsum')?.textContent).toBe('2 files · +6 −0');
    expect(d.querySelector('summary .mb-dhead')).toBeNull();
    expect(d.querySelector('.mb-dhead')?.parentElement).toBe(d.querySelector('.mb-diff'));
    expect(d.querySelector('.mb-dopen')?.hasAttribute('hidden')).toBe(true);
  });
  it('has one scroller with a label and keyboard focus', () => {
    const d = block(many(2, 4));
    const s = d.querySelectorAll('.mb-dscroll');
    expect(s.length).toBe(1);
    expect(s[0].getAttribute('tabindex')).toBe('0');
    expect(s[0].getAttribute('aria-label')).toBe('Diff, 2 files');
    expect(s[0].querySelectorAll('details.mb-file').length).toBe(2);
  });
  it('splits the path into a folder and a name', () => {
    const d = block('--- a/web/src/a.ts\n+++ b/web/src/a.ts\n@@ -1 +1 @@\n+x');
    expect(d.querySelector('.mb-dir')?.textContent).toBe('web/src/');
    expect(d.querySelector('.mb-name')?.textContent).toBe('a.ts');
  });
});
