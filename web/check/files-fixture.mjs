import { makePdf } from '../src/files/pdfFixture.ts';

// A stubbed Files API for the browser checks (S-1526): fixed roots, one folder, and three files: one with a very long line, a Markdown note, and a three-page PDF (S-1528).
export async function routeFiles(ctx, origin) {
  await ctx.route(`${origin}/api/files/**`, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const path = q.get('path') ?? '';
    if (route.request().url().includes('/list')) {
      if (!path) return route.fulfill({ json: { host: q.get('host'), roots: [{ path: '/fx/projects', name: 'projects' }] } });
      return route.fulfill({ json: { host: q.get('host'), path, entries: [{ name: 'src', kind: 'dir', size: 0, mtime: 1 }, { name: 'long.ts', kind: 'file', size: 900, mtime: 1 }, { name: 'note.md', kind: 'file', size: 40, mtime: 1 }, { name: 'sample.pdf', kind: 'file', size: 1200, mtime: 1 }, { name: 'huge.png', kind: 'file', size: 209715200, mtime: 1 }] } });
    }
    // An image over the cap (S-1915): only its headers matter, the page cancels the body.
    if (path.endsWith('huge.png')) return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-stam-size': String(200 * 1024 * 1024) }, body: '' });
    if (path.endsWith('.pdf')) return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'x-stam-size': '1200' }, body: makePdf(3) });
    if (path.endsWith('note.md')) return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '# Note\n\nHello **files**.\n' });
    return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: Array.from({ length: 40 }, (_, i) => i === 4 ? `const wide = '${'x'.repeat(300)}'` : `const n${i + 1} = ${i + 1}`).join('\n') + '\n' });
  });
}
