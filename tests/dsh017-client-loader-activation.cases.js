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

test('0.1.7 prelude removes legacy settingsScope activation dependency before loader activation', () => {
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
  const sandbox = {
    window,
    fetch: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          value: {
            value: { routing: false },
            base: {},
            user: {},
            revision: 0,
            writable: true,
          },
        }
      },
    }),
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
    ['slots', 'locale', 'sessions', 'remote'],
  )
  assert.equal(plugin.apply({}), 'applied')
  assert.equal(typeof observed.ctx.settingsScope.bind, 'function')
  assert.equal(
    typeof observed.ctx.settingsScope.bind({ namespace: 'vision-router' }).getSnapshot,
    'function',
  )
})
