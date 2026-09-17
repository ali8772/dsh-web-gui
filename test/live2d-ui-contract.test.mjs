import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('Live2D settings expose modal status, focus, and labelled input contracts', async () => {
  const [widget, style] = await Promise.all([
    readFile(resolve(root, 'src/client/widget.tsx'), 'utf8'),
    readFile(resolve(root, 'src/client/style.css'), 'utf8'),
  ])

  assert.match(widget, /'aria-busy': live2d\.phase === 'loading' \|\| live2dListBusy/)
  assert.match(widget, /htmlFor: 'wp-live2d-file'/)
  assert.match(widget, /htmlFor: 'wp-live2d-url'/)
  assert.match(widget, /htmlFor: 'wp-live2d-scale'/)
  assert.match(widget, /event\.key === 'Tab'/)
  assert.match(widget, /focusableSettingsElements\(\)\[0\]\?\.focus\(\)/)
  assert.match(widget, /dialog\.contains\(active\)/)
  assert.match(widget, /deferredSummaryRef/)
  assert.match(widget, /summaryDialog !== null && !live2dOpen/)
  assert.match(widget, /live2dListError/)
  assert.match(widget, /Live2DRecentModels/)
  assert.match(widget, /恢复默认鲸鱼娘（保留最近模型）/)
  assert.match(style, /\.wp-live2d-model-switch:focus-visible/)
  assert.match(style, /\.wp-live2d-model-delete:focus-visible/)
})
