import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'
import { SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE } from '../lib/web/remote-settings-client.js'

function loadVisionClientThroughSettingsCompat(factory, options = {}) {
  let loaded
  const loader = {
    mode: 'live',
    create() {},
    load(spec) {
      loaded = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader, ...(options.window || {}) }
  Function('window', SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE)(window)
  loader.load({ id: 'dsh-vision-router', factory })
  assert.ok(loaded)
  return loaded.factory(() => ({}))
}

test('native cards cannot bypass staged edits through immediate reset', () => {
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /async function resetField\(key\)\{if\(cardDirty\|\|!scope\|\|typeof scope\.unset!==['"]function['"]\|\|!writable\|\|saving\)return/,
  )
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /className:['"]vr-reset['"],disabled:cardDirty\|\|!writable\|\|saving/,
  )
})

test('a settled save only collapses the disclosure that started that save', () => {
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /setCardsOpen\(function\(previous\)/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /previous\[id\]!==true/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /delete next\[id\]/)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /setCardsOpen\(\{\}\);\s*setSaveState\(\{status:['"]saved['"]/)
})

test('disclosure toggles are card-local instead of accordion-wide', () => {
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /function toggleCard\(id\)\{setCardsOpen\(function\(previous\)\{var next=Object\.assign\(\{\},previous\);if\(next\[id\]===true\)delete next\[id\];else next\[id\]=true;return next;\}\);\}/,
  )
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /setPage\(opened\?['"]['"]:id\)/)
})

test('DSH 0.1.7 configForms replaces the retired settingsScope service without parking the client', () => {
  const form = { id: 'vision-router-form' }
  let appliedScope
  const bundle = loadVisionClientThroughSettingsCompat(() => ({
    inject: ['settingsScope', 'slots', 'locale', 'sessions', 'remote'],
    apply(ctx) {
      appliedScope = ctx.settingsScope.bind({ namespace: 'vision-router' })
    },
  }))

  assert.deepEqual(bundle.inject, ['slots', 'locale', 'sessions', 'remote'])
  bundle.apply({
    get(name) {
      if (name === 'settingsScope') throw new Error('cannot get property "settingsScope" without inject')
      if (name === 'configForms') {
        return {
          get(namespace) {
            assert.equal(namespace, 'vision-router')
            return form
          },
        }
      }
      return undefined
    },
  })
  assert.equal(appliedScope, form)
})

test('legacy DSH settingsScope remains the preferred settings face across the support window', () => {
  const legacyScope = { id: 'legacy-scope' }
  let appliedScope
  const bundle = loadVisionClientThroughSettingsCompat(() => ({
    inject: ['settingsScope', 'slots'],
    apply(ctx) {
      appliedScope = ctx.settingsScope.bind({ namespace: 'vision-router' })
    },
  }))

  bundle.apply({
    get(name) {
      if (name === 'settingsScope') {
        return { bind: ({ namespace }) => namespace === 'vision-router' ? legacyScope : undefined }
      }
      if (name === 'configForms') throw new Error('configForms must not be required on legacy Hosts')
      return undefined
    },
  })
  assert.equal(appliedScope, legacyScope)
})

test('legacy configForms loader wrapper preserves loopback page authority for Connection reads', () => {
  const connection = { isLoopback: false, rpc: { call() {} } }
  let appliedConnection
  const bundle = loadVisionClientThroughSettingsCompat(() => ({
    inject: ['settingsScope', 'slots'],
    apply(ctx) {
      appliedConnection = ctx.get('connection')
    },
  }), { window: { location: { hostname: '127.0.0.1' } } })

  bundle.apply({
    get(name) {
      if (name === 'connection') return connection
      if (name === 'configForms') return { get() { return {} } }
      return undefined
    },
  })

  assert.equal(connection.isLoopback, false, 'the shared Host service must not be mutated')
  assert.equal(appliedConnection.isLoopback, true, 'the DVR view must retain loopback page authority')
  assert.equal(appliedConnection.rpc, connection.rpc)
})
