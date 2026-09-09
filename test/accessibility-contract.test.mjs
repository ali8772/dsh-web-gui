import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('widget exposes keyboard-operable tasks and modal dialog semantics', async () => {
  const widget = await readFile(resolve(root, 'src/client/widget.tsx'), 'utf8')
  assert.match(widget, /role:\s*'button'/)
  assert.match(widget, /tabIndex:\s*0/)
  assert.match(widget, /event\.key === 'Enter'/)
  assert.match(widget, /event\.key === ' '/)
  assert.match(widget, /role:\s*'dialog'/)
  assert.match(widget, /'aria-modal':\s*true/)
  assert.match(widget, /event\.key === 'Escape'/)
  assert.match(widget, /focus\(\)/)
})

test('status text is announced and decorative visuals are hidden from assistive technology', async () => {
  const widget = await readFile(resolve(root, 'src/client/widget.tsx'), 'utf8')
  assert.match(widget, /role:\s*'status'/)
  assert.match(widget, /'aria-live':\s*'polite'/)
  assert.match(widget, /'aria-hidden':\s*true/)
})

test('reduced-motion disables continuous and scrolling animations', async () => {
  const css = await readFile(resolve(root, 'src/client/style.css'), 'utf8')
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  assert.match(css, /animation-duration:\s*0\.01ms/)
  assert.match(css, /transition-duration:\s*0\.01ms/)
  const widget = await readFile(resolve(root, 'src/client/widget.tsx'), 'utf8')
  assert.match(widget, /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)/)
  assert.match(widget, /if \(reducedMotion \|\| mode !== 1/)
})
