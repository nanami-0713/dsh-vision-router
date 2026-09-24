import {
  DSH_017_SETTINGS_COMPAT_MARK,
  LOCAL_SETTINGS_PATH,
} from '../dsh-settings-017-compat.js'

const BODY_LIMIT_BYTES = 256 * 1024
const ROOT_TRANSPORT_REGISTRY_KEY = Symbol.for('dsh-vision-router.settings-017-root-local-transport')

function objectLike(value) {
  return value !== null && typeof value === 'object'
}

function transportRegistry() {
  let registry = globalThis[ROOT_TRANSPORT_REGISTRY_KEY]
  if (!(registry instanceof WeakMap)) {
    registry = new WeakMap()
    Object.defineProperty(globalThis, ROOT_TRANSPORT_REGISTRY_KEY, {
      value: registry,
      configurable: true,
    })
  }
  return registry
}

function rootOf(ctx) {
  try {
    if (objectLike(ctx?.root)) return ctx.root
  } catch {}
  return ctx
}

function stateFor(root) {
  const registry = transportRegistry()
  let state = registry.get(root)
  if (!state) {
    state = {
      current: undefined,
      routeInstalled: false,
    }
    registry.set(root, state)
  }
  return state
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

function compatibleSettings(ctx) {
  const settings = serviceOf(ctx, 'settings')
  if (settings?.[DSH_017_SETTINGS_COMPAT_MARK] !== true) return undefined
  if (typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') return undefined
  return settings
}

function namespaceDescriptor(settings) {
  const descriptors = settings.describe({ redactSecrets: true })
  return Array.isArray(descriptors) ? descriptors.find((entry) => entry?.ns === 'vision-router') : undefined
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

function currentSettings(state) {
  const generation = state.current
  if (!generation || generation.active === false) return undefined
  try {
    return generation.resolve()
  } catch {
    return undefined
  }
}

function routeFor(state) {
  return {
    kind: 'exact',
    path: LOCAL_SETTINGS_PATH,
    async handler(req, res) {
      const settings = currentSettings(state)
      if (!settings) {
        sendJson(res, 404, { ok: false, error: { code: 'settings-unavailable', message: 'Vision Router settings are unavailable' } })
        return
      }

      if (req.method === 'GET') {
        const descriptor = namespaceDescriptor(settings)
        if (!descriptor) {
          sendJson(res, 404, { ok: false, error: { code: 'settings-unavailable', message: 'Vision Router settings are unavailable' } })
          return
        }
        sendJson(res, 200, { ok: true, value: { ...descriptor, writable: settings.writable === true } })
        return
      }

      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST')
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
        return
      }

      try {
        const payload = await readJson(req)
        await settings.mutate('vision-router', payload?.ops, payload?.expectedRevision)

        // ConfigEditor.edit() reconciles the profile and can dispose the plugin
        // generation that accepted this request. The route itself is root-owned,
        // so finish the response from the newly-mounted generation when present.
        const afterSettings = currentSettings(state) ?? settings
        const descriptor = namespaceDescriptor(afterSettings)
        if (!descriptor) throw new Error('Vision Router settings disappeared after the write')
        sendJson(res, 200, { ok: true, value: { ...descriptor, writable: afterSettings.writable === true } })
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
  }
}

function ensureRootRoute(root, webCtx, state) {
  if (state.routeInstalled) return
  state.routeInstalled = true
  try {
    const effectOwner = typeof root?.effect === 'function' ? root : webCtx
    if (typeof effectOwner?.effect !== 'function') {
      throw new Error('Vision Router requires a lifecycle owner for the DSH 0.1.7 local settings route')
    }
    effectOwner.effect(
      () => webCtx.webServer.register(routeFor(state)),
      'vision-router: DSH 0.1.7 root local settings transport',
    )
  } catch (error) {
    state.routeInstalled = false
    throw error
  }
}

/**
 * ConfigEditor.edit() reconciles the plugin configuration and therefore disposes
 * the DVR plugin fiber while a Settings POST is still in flight. Mount the HTTP
 * route on the application root exactly once and let each DVR generation merely
 * publish a resolver for its current compatibility facade. This keeps the request
 * alive across HMR without making the settings facade itself root-owned.
 */
export function installDsh017RootLocalSettingsTransport(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  const root = rootOf(ctx)
  if (!objectLike(root)) return
  const state = stateFor(root)

  ctx.inject(['settings', 'webServer'], (webCtx) => {
    const mounted = compatibleSettings(webCtx)
    if (!mounted) return

    const generation = {
      active: true,
      resolve: () => compatibleSettings(ctx) ?? mounted,
    }
    state.current = generation
    ensureRootRoute(root, webCtx, state)

    if (typeof webCtx?.effect === 'function') {
      webCtx.effect(
        () => () => {
          generation.active = false
          if (state.current === generation) state.current = undefined
        },
        'vision-router: DSH 0.1.7 settings generation',
      )
    }
  })
}
