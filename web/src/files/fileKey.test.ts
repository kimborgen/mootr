import { beforeEach, describe, expect, it } from 'vitest'
import { crumbs, fileKey, kindOf, onRecent, parentOf, parseFileKey, parseFileLink, pathBoxTarget, pushRecent, readRecent } from './fileKey'
import { formatSize } from '../format'
import { validKey } from '../views/registry'

describe('file keys', () => {
  it('round-trips a key with and without a line', () => {
    expect(parseFileKey(fileKey('host1', '/home/user/a.ts'))).toEqual({ host: 'host1', path: '/home/user/a.ts' })
    expect(parseFileKey(fileKey('storage', '/x/y.md', 42))).toEqual({ host: 'storage', path: '/x/y.md', line: 42 })
  })
  it('keeps colons and spaces in the path', () => {
    expect(parseFileKey('file:h:/a b/c:d.txt#L3')).toEqual({ host: 'h', path: '/a b/c:d.txt', line: 3 })
  })
  it('refuses keys that are not files', () => {
    for (const k of ['file:', 'file:host', 'file:host:relative', 'file::/x', 'agent:x']) expect(parseFileKey(k)).toBeNull()
  })
  it('reads a deep link without the prefix', () => {
    expect(parseFileLink('host1:/a/b.ts#L7')).toEqual({ host: 'host1', path: '/a/b.ts', line: 7 })
  })
  it('is a valid view key, and so is the Files world', () => {
    expect(validKey('file:h:/a')).toBe(true)
    expect(validKey('files')).toBe(true)
    expect(validKey('file:h')).toBe(false)
  })
})

describe('paths', () => {
  it('splits breadcrumbs', () => {
    expect(crumbs('/a/b/c.ts')).toEqual([{ name: 'a', path: '/a' }, { name: 'b', path: '/a/b' }, { name: 'c.ts', path: '/a/b/c.ts' }])
    expect(crumbs('/')).toEqual([])
  })
  it('finds a parent', () => {
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
  })
  it('reads the path box', () => {
    expect(pathBoxTarget(' /x/y ', 'here')).toEqual({ host: 'here', path: '/x/y' })
    expect(pathBoxTarget('storage:/data', 'here')).toEqual({ host: 'storage', path: '/data' })
    expect(pathBoxTarget('~/projects', 'here')).toEqual({ host: 'here', path: '~/projects' })
    expect(pathBoxTarget('relative/path', 'here')).toBeNull()
  })
})

describe('kindOf', () => {
  it('lets the content type win', () => {
    expect(kindOf('a.txt', 'image/png')).toBe('image')
    expect(kindOf('a.png', 'application/octet-stream')).toBe('download')
    expect(kindOf('a.md', 'text/plain; charset=utf-8')).toBe('markdown')
    expect(kindOf('a.ts', 'text/plain; charset=utf-8')).toBe('text')
    expect(kindOf('a.pdf', 'application/pdf')).toBe('pdf')
    expect(kindOf('a.mp4', 'video/mp4')).toBe('download')
  })
  it('guesses by extension without a type', () => {
    expect(kindOf('a.JPG')).toBe('image')
    expect(kindOf('README.md')).toBe('markdown')
    expect(kindOf('a.pdf')).toBe('pdf')
    expect(kindOf('Makefile')).toBe('text')
  })
})

describe('recent files', () => {
  beforeEach(() => localStorage.clear())
  it('puts the latest first, once, up to 12', () => {
    pushRecent({ host: 'h', path: '/a' })
    pushRecent({ host: 'h', path: '/b' })
    pushRecent({ host: 'h', path: '/a', line: 3 })
    expect(readRecent()).toEqual([{ host: 'h', path: '/a' }, { host: 'h', path: '/b' }])
    for (let i = 0; i < 20; i++) pushRecent({ host: 'h', path: '/f' + i })
    expect(readRecent()).toHaveLength(12)
  })
  it('reads garbage and a failing storage as empty', () => {
    localStorage.setItem('stam/files-recent', '{nope')
    expect(readRecent()).toEqual([])
    const get = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try { expect(readRecent()).toEqual([]) } finally { Storage.prototype.getItem = get }
  })
})

describe('formatSize', () => {
  it('scales', () => {
    expect(formatSize(12)).toBe('12 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('recent notifications', () => {
  it('tells listeners when a file is pushed', () => {
    localStorage.clear()
    let n = 0
    const off = onRecent(() => { n++ })
    pushRecent({ host: 'h', path: '/z' })
    off()
    pushRecent({ host: 'h', path: '/y' })
    expect(n).toBe(1)
  })
})
