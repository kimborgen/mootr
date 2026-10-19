/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The daemon serves the build at /web/ (web/dist). For development, `npm run dev`
// proxies /api, including terminal WebSockets, to a daemon: STAM_PORT (default 7878)
// on 127.0.0.1. Point it at a test daemon from test/lib.sh, never the live one, to try
// changes that write.
const port = process.env.STAM_PORT ?? '7878'
let token = ''
try {
  token = readFileSync(`${process.env.STAM_HOME ?? process.env.HOME + '/.local/share/stam'}/token`, 'utf8').trim()
} catch {}

export default defineConfig(({ command }) => ({
  base: '/web/',
  plugins: [react()],
  // Two pages: the app, and the stories page (/stories, docs/stories.md).
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4096, rollupOptions: { input: { main: 'index.html', stories: 'stories.html' } } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['src/test-setup.ts'] },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    host: '127.0.0.1',
    proxy: {
      '/api': { target: `http://127.0.0.1:${port}`, ws: true, changeOrigin: false },
    },
  },
  // The dev server signs in with the daemon's token; a build never carries one.
  define: { __DEV_TOKEN__: JSON.stringify(command === 'serve' ? token : '') },
}))
