import { createHash } from 'node:crypto'

const SETTINGS_NS = 'vision-router'
export const LOCAL_SETTINGS_PATH = '/_dsh/vision-router/local-settings'
export const DSH_017_SETTINGS_COMPAT_MARK = '__visionRouterDsh017ConfigEditorCompat'
const BODY_LIMIT_BYTES = 256 * 1024

function objectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function plainObject(value) {
  if (!objectLike(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function mergeResolved(base, overlay) {
  if (!plainObject(base) || !plainObject(overlay)) return clone(overlay)
  const next = clone(base)
  for (const [key, value] of Object.entries(overlay)) {
    next[key] = plainObject(value) && plainObject(next[key])
      ? mergeResolved(next[key], value)
      : clone(value)
  }
  return next
}

function jsonEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!plainObject(left) || !plainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
}

function logicalUserLayer(current, inherited) {
  const user = Object.create(null)
  const keys = new Set([
    ...Object.keys(objectLike(current) ? current : {}),
    ...Object.keys(objectLike(inherited) ? inherited : {}),
  ])
  for (const key of keys) {
    const currentHas = objectLike(current) && Object.hasOwn(current, key)
    const inheritedHas = objectLike(inherited) && Object.hasOwn(inherited, key)
    if (currentHas === inheritedHas && (!currentHas || jsonEqual(current[key], inherited[key]))) continue
    if (currentHas) user[key] = clone(current[key])
  }
  return user
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!plainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function fingerprint(value) {
  return JSON.stringify(stableValue(value))
}

/**
 * Optimistic-write revisions must survive DVR's own ordinary-Config HMR.
 * Hash the exact persisted/effective layers into a safe integer instead of
 * keeping a plugin-instance-local counter that resets after ConfigEditor.edit().
 */
function revisionFor(current, inherited) {
  const digest = createHash('sha256')
    .update(fingerprint({ current, inherited }))
    .digest('hex')
    .slice(0, 12)
  return Number.parseInt(digest, 16)
}

function serviceOf(ctx, name) {
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (value !== undefined && value !== null) return value
  } catch {}
  try {
    const value = ctx?.[name]
    return value === undefined || value === null ? undefined : value
  } catch {
    return undefined
  }
}

function configEditorRow(editor, namespace) {
  const rows = typeof editor?.configuration === 'function' ? editor.configuration() : []
  if (!Array.isArray(rows)) return undefined
  return rows.find((row) => row?.entry?.options?.id === namespace)
}

function settingsConflict(expected, actual) {
  const error = new Error(`Vision Router settings changed before this write landed (expected ${expected}, actual ${actual})`)
  error.code = 'SETTINGS_CONFLICT'
  error.expected = expected
  error.actual = actual
  return error
}

function admissionError(message) {
  const error = new Error(message)
  error.code = 'SETTINGS_INVALID_MUTATION'
  return error
}

function validateOperations(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw admissionError('settings operations must be a non-empty array')
  return ops.map((op) => {
    if (!objectLike(op) || (op.op !== 'set' && op.op !== 'unset')) {
      throw admissionError('settings operation must be set or unset')
    }
    if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== 'string' || op.path[0] === '') {
      throw admissionError('Vision Router settings compatibility accepts one top-level field per operation')
    }
    const key = op.path[0]
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw admissionError('unsafe settings field name')
    }
    return op.op === 'set'
      ? { op: 'set', path: [key], value: clone(op.value) }
      : { op: 'unset', path: [key] }
  })
}

function applyOperations(current, inherited, ops) {
  const next = clone(objectLike(current) ? current : {})
  for (const op of ops) {
    const key = op.path[0]
    if (op.op === 'set') {
      next[key] = clone(op.value)
      continue
    }
    if (objectLike(inherited) && Object.hasOwn(inherited, key)) next[key] = clone(inherited[key])
    else delete next[key]
  }
  return next
}

function createConfigEditorSettingsFacade(editor, entryConfig, namespace) {
  const listeners = new Set()

  function state() {
    const row = configEditorRow(editor, namespace)
    if (!row) return undefined
    const current = objectLike(row.entry?.options?.config) ? row.entry.options.config : {}
    const inherited = objectLike(row.inherited) ? row.inherited : {}
    const base = mergeResolved(entryConfig, inherited)
    const value = mergeResolved(entryConfig, current)
    return {
      row,
      descriptor: {
        ns: namespace,
        value,
        base,
        user: logicalUserLayer(current, inherited),
        revision: revisionFor(current, inherited),
        applies: true,
      },
    }
  }

  function notify(value) {
    for (const listener of [...listeners]) {
      try { listener(value, undefined) } catch {}
    }
  }

  const scope = {
    get() {
      return state()?.descriptor.value ?? entryConfig
    },
    watch(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    get writable() {
      return state() !== undefined
    },
    get(namespaceName) {
      return namespaceName === namespace ? scope.get() : undefined
    },
    register(namespaceName) {
      if (namespaceName !== namespace) {
        throw new Error(`vision-router: unexpected settings namespace ${String(namespaceName)}`)
      }
      return scope
    },
    describe() {
      const current = state()
      return current ? [clone(current.descriptor)] : []
    },
    async mutate(namespaceName, operations, expectedRevision) {
      if (namespaceName !== namespace) throw new Error(`No configurable plugin entry ${JSON.stringify(namespaceName)}`)
      const before = state()
      if (!before) throw new Error(`No configurable plugin entry ${JSON.stringify(namespace)}`)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw admissionError('expectedRevision must be a non-negative safe integer')
      }
      if (expectedRevision !== before.descriptor.revision) {
        throw settingsConflict(expectedRevision, before.descriptor.revision)
      }
      const ops = validateOperations(operations)
      const entry = before.row.entry
      await editor.edit(entry, (current, inherited) => applyOperations(current, inherited, ops))
      const after = state()
      if (!after) throw new Error('Vision Router configuration entry disappeared after the write')
      notify(after.descriptor.value)
      return clone(after.descriptor)
    },
  }
}

/**
 * DSH 0.1.7 services may mount after DVR's apply() starts. Capture ConfigEditor
 * through its own lifecycle injection and resolve the settings generation when
 * each consumer actually accesses it. This avoids both startup-order races and
 * undeclared child-context service reads.
 */
function contextWithLazySettingsCompatibility(ctx, entryConfig, namespace) {
  const wrappers = new WeakMap()
  const facades = new WeakMap()
  let injectedEditor

  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['configEditor'], (editorCtx) => {
        injectedEditor = serviceOf(editorCtx, 'configEditor')
      })
    }
  } catch {
    // Older Hosts may not expose ConfigEditor; their native SettingsProvider stays authoritative.
  }

  function compatibleSettings(target) {
    const settings = serviceOf(target, 'settings') ?? serviceOf(ctx, 'settings')
    if (!settings || typeof settings.register === 'function') return settings
    const editor = serviceOf(target, 'configEditor') ?? injectedEditor ?? serviceOf(ctx, 'configEditor')
    if (typeof settings.describe !== 'function'
        || !editor || typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
      return settings
    }
    let facade = facades.get(editor)
    if (!facade) {
      facade = createConfigEditorSettingsFacade(editor, entryConfig, namespace)
      facades.set(editor, facade)
    }
    return facade
  }

  function wrap(target) {
    if (!target || typeof target !== 'object') return target
    const held = wrappers.get(target)
    if (held) return held
    const wrapped = new Proxy(target, {
      get(object, property) {
        if (property === 'settings') return compatibleSettings(object)
        if (property === 'get') {
          const get = Reflect.get(object, property, object)
          if (typeof get !== 'function') return get
          return (name, ...rest) => name === 'settings'
            ? compatibleSettings(object)
            : get.call(object, name, ...rest)
        }
        if (property === 'inject') {
          const inject = Reflect.get(object, property, object)
          if (typeof inject !== 'function') return inject
          return (dependencies, callback, ...rest) => inject.call(
            object,
            dependencies,
            typeof callback === 'function' && Array.isArray(dependencies) && dependencies.includes('settings')
              ? (child) => callback(wrap(child))
              : callback,
            ...rest,
          )
        }
        const value = Reflect.get(object, property, object)
        return typeof value === 'function' ? value.bind(object) : value
      },
    })
    wrappers.set(target, wrapped)
    return wrapped
  }

  return wrap(ctx)
}

/**
 * DSH 0.1.7 removes the legacy SettingsProvider.register() namespace API and
 * makes ordinary plugin configuration profile-owned through ConfigEditor.
 * Preserve DVR's mature settings consumers behind the old semantic face while
 * leaving older Hosts on their native SettingsProvider whenever it is present.
 */
export function installDsh017SettingsCompatibility(ctx, entryConfig = {}, options = {}) {
  const namespace = typeof options.namespace === 'string' && options.namespace !== '' ? options.namespace : SETTINGS_NS
  return contextWithLazySettingsCompatibility(ctx, entryConfig, namespace)
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > BODY_LIMIT_BYTES) throw Object.assign(new Error('request body too large'), { statusCode: 413 })
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function namespaceDescriptor(settings) {
  const descriptors = settings.describe({ redactSecrets: true })
  return Array.isArray(descriptors) ? descriptors.find((entry) => entry?.ns === SETTINGS_NS) : undefined
}

/** Local-only transport for the 0.1.7 browser, which no longer exposes settingsScope. */
export function installDsh017LocalSettingsTransport(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['settings', 'webServer'], (webCtx) => {
    if (webCtx.settings?.[DSH_017_SETTINGS_COMPAT_MARK] !== true) return
    if (typeof webCtx.settings.describe !== 'function' || typeof webCtx.settings.mutate !== 'function') return
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: LOCAL_SETTINGS_PATH,
        async handler(req, res) {
          if (req.method === 'GET') {
            const descriptor = namespaceDescriptor(webCtx.settings)
            if (!descriptor) {
              sendJson(res, 404, { ok: false, error: { code: 'settings-unavailable', message: 'Vision Router settings are unavailable' } })
              return
            }
            sendJson(res, 200, { ok: true, value: { ...descriptor, writable: webCtx.settings.writable === true } })
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
            return
          }
          try {
            const payload = await readJson(req)
            await webCtx.settings.mutate(SETTINGS_NS, payload?.ops, payload?.expectedRevision)
            const descriptor = namespaceDescriptor(webCtx.settings)
            if (!descriptor) throw new Error('Vision Router settings disappeared after the write')
            sendJson(res, 200, { ok: true, value: { ...descriptor, writable: webCtx.settings.writable === true } })
          } catch (error) {
            const conflict = error?.code === 'SETTINGS_CONFLICT'
            sendJson(res, error?.statusCode ?? (conflict ? 409 : 400), {
              ok: false,
              error: {
                code: conflict ? 'settings-conflict' : 'settings-rejected',
                message: error?.message ?? String(error),
                ...(conflict ? { details: { expected: error.expected, actual: error.actual } } : {}),
              },
            })
          }
        },
      }),
      'vision-router: DSH 0.1.7 local settings transport',
    )
  })
}
