import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

import {
  SETTINGS_017_CLIENT_PRELUDE,
  installSettings017ClientCompatibility,
} from '../lib/settings-client-017-compat.js'

test('0.1.7 server-side client shim is fenced by ConfigEditor availability', () => {
  let dependencies
  let taps = 0
  const ctx = {
    inject(received, callback) {
      dependencies = received
      callback({
        effect(factory) { factory() },
        webServer: {
          tapIndex(transform) {
            assert.equal(typeof transform, 'function')
            taps += 1
            return () => {}
          },
        },
      })
      return () => {}
    },
  }

  installSettings017ClientCompatibility(ctx)
  assert.deepEqual(dependencies, ['configEditor', 'webServer'])
  assert.equal(taps, 1)
})

test('0.1.7 prelude replaces legacy settingsScope activation with native configForms', () => {
  let loadedSpec
  let fetched = 0
  let requestedNamespace
  const form = {
    getSnapshot() {
      return {
        status: 'ready',
        value: { routing: false },
        base: {},
        user: {},
        revision: 0,
        writable: true,
        mode: 'host',
      }
    },
    subscribe() { return () => {} },
    async set() { return true },
    async unset() { return true },
    async mutate() { return true },
    async dispose() {},
  }
  const configForms = {
    get(namespace) {
      requestedNamespace = namespace
      return form
    },
  }
  const loader = {
    mode: 'live',
    load(spec) {
      loadedSpec = spec
      return spec
    },
    create() { return this },
  }
  const window = { __ModuleLoader__: loader }
  const sandbox = {
    window,
    fetch: async () => {
      fetched += 1
      throw new Error('the native configForms path must not use the fallback HTTP transport')
    },
  }

  runInNewContext(SETTINGS_017_CLIENT_PRELUDE, sandbox)

  const observed = {}
  loader.load({
    id: 'dsh-vision-router',
    factory: () => ({
      inject: ['settingsScope', 'slots', 'locale', 'sessions', 'remote'],
      apply(ctx) {
        observed.ctx = ctx
        return 'applied'
      },
    }),
  })

  const plugin = loadedSpec.factory(() => undefined)
  assert.deepEqual(
    Array.from(plugin.inject),
    ['configForms', 'slots', 'locale', 'sessions', 'remote'],
  )
  assert.equal(plugin.apply({ configForms }), 'applied')
  assert.equal(typeof observed.ctx.settingsScope.bind, 'function')
  assert.equal(observed.ctx.settingsScope.bind({ namespace: 'vision-router' }), form)
  assert.equal(requestedNamespace, 'vision-router')
  assert.equal(fetched, 0)
})

test('0.1.7 prelude restores configForms dependency when another loader shim stripped settingsScope first', () => {
  let loadedSpec
  const loader = {
    mode: 'live',
    load(spec) {
      loadedSpec = spec
      return spec
    },
    create() { return this },
  }
  const window = { __ModuleLoader__: loader }
  runInNewContext(SETTINGS_017_CLIENT_PRELUDE, { window, fetch: async () => { throw new Error('unexpected fetch') } })

  loader.load({
    id: 'dsh-vision-router',
    factory: () => ({
      inject: ['slots', 'locale', 'sessions', 'remote'],
      apply() {},
    }),
  })

  const plugin = loadedSpec.factory(() => undefined)
  assert.deepEqual(
    Array.from(plugin.inject),
    ['configForms', 'slots', 'locale', 'sessions', 'remote'],
  )
})
