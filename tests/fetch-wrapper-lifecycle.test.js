import test from 'node:test'
import assert from 'node:assert/strict'
import { installFetchWrapper } from '../lib/fetch-wrapper-lifecycle.js'

function accessorPipeline(target) {
  const previous = Object.getOwnPropertyDescriptor(target, 'fetch')
  let underlying = target.fetch
  let assignments = 0
  const pipeline = (...args) => underlying(...args)
  const descriptor = {
    configurable: true,
    enumerable: false,
    get() { return pipeline },
    set(next) { assignments += 1; underlying = next },
  }
  Object.defineProperty(target, 'fetch', descriptor)
  return { descriptor, pipeline, assignments: () => assignments, restore() {
    Object.defineProperty(target, 'fetch', previous)
  } }
}

for (const order of ['pipeline-first', 'wrapper-first']) {
  test(`fetch descriptor composes without feeding its wrapper to a setter: ${order}`, () => {
    const calls = []
    const target = { fetch(value) { calls.push(value); return 'host' } }
    const original = target.fetch
    let pipeline
    let active = true
    if (order === 'pipeline-first') pipeline = accessorPipeline(target)
    const next = target.fetch
    const wrapped = (value) => next(active ? `wrapped:${value}` : value)
    const restore = installFetchWrapper(wrapped, target)
    if (order === 'wrapper-first') pipeline = accessorPipeline(target)
    assert.equal(target.fetch('one'), 'host')
    assert.deepEqual(calls, ['wrapped:one'])
    assert.equal(pipeline.assignments(), 0)
    active = false
    restore()
    assert.equal(target.fetch('two'), 'host')
    assert.equal(calls.at(-1), 'two')
    assert.equal(pipeline.assignments(), 0, 'cleanup must not invoke a foreign setter')
    assert.equal(Object.getOwnPropertyDescriptor(target, 'fetch').get, pipeline.descriptor.get)
    pipeline.restore()
    if (order === 'pipeline-first') assert.equal(target.fetch, original)
  })
}

test('reverse disposal skips already retired DVR wrappers and restores the accessor', () => {
  const target = { fetch: () => 'host' }
  const pipeline = accessorPipeline(target)
  const firstNext = target.fetch
  const first = (...args) => firstNext(...args)
  const restoreFirst = installFetchWrapper(first, target)
  const secondNext = target.fetch
  const second = (...args) => secondNext(...args)
  const restoreSecond = installFetchWrapper(second, target)
  restoreFirst()
  assert.equal(target.fetch, second)
  restoreSecond()
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'fetch'), pipeline.descriptor)
  assert.equal(target.fetch(), 'host')
  assert.equal(pipeline.assignments(), 0)
  restoreSecond()
  assert.equal(target.fetch, pipeline.pipeline)
})

test('cleanup never replaces a later accessor even if its getter returns our wrapper', () => {
  const target = { fetch: () => 'host' }
  const next = target.fetch
  const wrapped = (...args) => next(...args)
  const restore = installFetchWrapper(wrapped, target)
  let writes = 0
  const later = { configurable: true, get: () => wrapped, set() { writes += 1 } }
  Object.defineProperty(target, 'fetch', later)
  const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch')
  restore()
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'fetch'), descriptor)
  assert.equal(writes, 0)
})

test('cleanup respects later Host replacement and descriptor ownership', () => {
  const target = { fetch: () => 'old-host' }
  const restore = installFetchWrapper(() => 'wrapped', target)
  const replacement = () => 'new-host'
  target.fetch = replacement
  restore()
  assert.equal(target.fetch, replacement)
  const restoreAgain = installFetchWrapper(() => 'wrapped-again', target)
  Object.defineProperty(target, 'fetch', { enumerable: false })
  const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch')
  restoreAgain()
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'fetch'), descriptor)
})

test('restores inherited fetch without creating a permanent own property', () => {
  const prototype = { fetch: () => 'host' }
  const target = Object.create(prototype)
  const restore = installFetchWrapper(() => 'wrapped', target)
  restore()
  assert.equal(Object.hasOwn(target, 'fetch'), false)
  assert.equal(target.fetch(), 'host')
})

test('locked accessor fails without assigning or mutating Host policy', () => {
  let assignments = 0
  const target = {}
  Object.defineProperty(target, 'fetch', {
    configurable: false, get: () => () => 'host', set() { assignments += 1 },
  })
  const previous = Object.getOwnPropertyDescriptor(target, 'fetch')
  assert.throws(() => installFetchWrapper(() => 'wrapped', target), TypeError)
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'fetch'), previous)
  assert.equal(assignments, 0)
})

test('reinstalling the same wrapper is inert and disposal remains idempotent', () => {
  const original = () => 'host'
  const target = { fetch: original }
  const wrapped = () => original()
  const restore = installFetchWrapper(wrapped, target)
  const restoreDuplicate = installFetchWrapper(wrapped, target)
  restoreDuplicate()
  assert.equal(target.fetch, wrapped)
  restore()
  assert.equal(target.fetch, original)
  target.fetch = wrapped
  restore()
  assert.equal(target.fetch, wrapped, 'stale disposal cannot undo a later Host assignment')
})
