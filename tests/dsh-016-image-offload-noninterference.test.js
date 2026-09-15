import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { eventHasImage } from '../index.js'

test('DSH image/offload bookkeeping is not itself classified as new visual input', () => {
  const offload = {
    type: 'image/offload',
    data: {
      targets: [{ seq: 3, occurrences: [0, 2] }],
    },
  }
  assert.equal(eventHasImage(offload), false)
})

test('same-turn tool image events remain detectable after the offload generation', () => {
  const toolResult = {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'sha256:0123456789abcdef0123456789abcdef' },
          }],
        }],
      },
    },
  }
  assert.equal(eventHasImage(toolResult), true)
})

test('mid-turn raw event recovery starts at the captured turn boundary, not historical image events', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /startIndex:\s*events\.length/)
  assert.match(source, /for\s*\(let i = state\.startIndex; i < events\.length; i\+\+\)/)
})
