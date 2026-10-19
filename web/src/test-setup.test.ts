import { expect, it } from 'vitest'

// Regression for test-setup.ts: assistant-ui scrolls from a requestAnimationFrame
// callback that can run after the test that scheduled it. Without the stub, jsdom
// throws `scrollTo is not a function` there and vitest fails the whole run.
it('schedules a scroll in a frame that runs after the test', () => {
  requestAnimationFrame(() => { document.createElement('div').scrollTo(0, 0) })
})

it('lets that frame run without an unhandled error', async () => {
  await new Promise((r) => setTimeout(r, 100))
  expect(typeof Element.prototype.scrollIntoView).toBe('function')
})
