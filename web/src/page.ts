// This page load's id (S-1475): its image tabs are `image:PAGE.N`, and its layout stream names it, so the
// daemon knows which pages are live (src/layout.ts). Random per load, so a reload is a new page.
export const PAGE = Math.random().toString(36).slice(2, 8)
