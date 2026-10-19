// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
const opened = vi.hoisted(() => vi.fn())
vi.mock('../files/open', () => ({ openDiff: opened }))
import { hideMenu, menuOpen } from '../ui/menu'
import { handleRefClick, registerRefAction, runRef } from './refClicks'
import { refHtml } from './refs'

const click = (html: string) => {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
  const a = host.querySelector('a')!
  let handled = false
  host.addEventListener('click', (e) => { handled = handleRefClick(e) })
  a.dispatchEvent(ev)
  host.remove()
  return { handled, prevented: ev.defaultPrevented }
}

afterEach(() => hideMenu())

describe('reference link clicks', () => {
  it('runs the action of an in-app link', () => {
    const seen: string[] = []
    registerRefAction('test', (arg) => seen.push(arg))
    const r = click(refHtml('Settings › Spending', [{ label: 'x', hint: 'Open', action: 'test:spend' }]))
    expect(r).toEqual({ handled: true, prevented: true })
    expect(seen).toEqual(['spend'])
  })
  it('a diff action opens the PR\'s diff view (S-1918)', () => {
    const r = click(refHtml('#7', [{ label: 'View diff', hint: 'Diff', action: 'diff:stam2#7' }]))
    expect(r.handled).toBe(true)
    expect(opened).toHaveBeenCalledWith('stam2', 7)
  })
  it('opens the picker for a link with several targets', () => {
    const r = click(refHtml('#7', [{ label: 'a/b#7', hint: 'PR', url: 'https://github.com/a/b/pull/7' }, { label: 'S-1 Thing', hint: 'ITSA', action: 'itsa:i1' }]))
    expect(r).toEqual({ handled: true, prevented: true })
    expect(menuOpen()).toBe(true)
  })
  it('leaves a plain URL link to the browser', () => {
    const r = click(refHtml('#494', [{ label: 'a/b#494', hint: 'PR', url: 'https://github.com/a/b/pull/494' }]))
    expect(r).toEqual({ handled: false, prevented: false })
    expect(menuOpen()).toBe(false)
  })
  it('opens only https URLs, so a forged picker entry cannot run script', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    runRef({ label: 'x', hint: 'x', url: 'javascript:alert(1)' })
    expect(open).not.toHaveBeenCalled()
    runRef({ label: 'x', hint: 'x', url: 'https://github.com/a/b/pull/1' })
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })
})
