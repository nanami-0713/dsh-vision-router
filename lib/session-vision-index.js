import { currentSessionSurfacePolicy } from './session-surface-policy.js'
import { sessionSurfaceReplacementIntent } from './session-surface-compat.js'
import { createSessionVisionStateStore } from './session-vision-state.js'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function legacySessionEvents(session) {
  try {
    // dsh 0.1.2-alpha.4 removed the bare `session.events` array in favor of
    // `session.snapshotEvents()`; both are handled so one build runs on both
    // harness generations.
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : undefined
    }
    return Array.isArray(session?.events) ? session.events : undefined
  } catch {
    return undefined
  }
}

function surfaceNodes(session) {
  try {
    return Array.isArray(session?.surface?.nodes) ? session.surface.nodes : undefined
  } catch {
    return undefined
  }
}

function messagesFrom(payload, decision) {
  if (Array.isArray(decision?.messages)) return decision.messages
  return Array.isArray(payload?.messages) ? payload.messages : []
}

function boundedMessage(error) {
  const text = error?.message ?? error
  return String(text ?? '').slice(0, 400)
}

/**
 * Session visual data-plane index.
 *
 * SessionVisionStateStore remains the bounded storage owner. This object owns
 * target-only durable attachment recovery after bounded-cache eviction,
 * bounded Host-backed tool-result image surface repair and expired structured
 * guard-stop surface repair.
 *
 * The index never replaces stateStore.lookupAttachment(). Cache lookup stays
 * synchronous through lookupAttachment(); cold durable recovery is requested
 * explicitly through async resolveAttachment(), so I/O ownership remains visible.
 */
export function createSessionVisionIndex({
  stateStore,
  core,
  config = {},
  logger,
  readSessionEvent,
  readSessionLog,
} = {}) {
  if (!core || typeof core !== 'object') throw new TypeError('session vision index requires core helpers')

  // Direct/test callers get an isolated bounded store rather than discovering
  // a module-global "current" owner. Production passes the composition-owned
  // SessionVisionRuntime store explicitly.
  const store = stateStore ?? createSessionVisionStateStore()
  if (!store || typeof store !== 'object') {
    throw new TypeError('session vision index requires a state store')
  }
  const primitiveLookup = typeof store.lookupAttachment === 'function'
    ? store.lookupAttachment.bind(store)
    : undefined
  const toolSurfaceScans = new WeakMap()
  const guardSurfaceScans = new WeakMap()
  const unsupportedSurfaceContracts = new WeakSet()
  const repairReadWarnings = new WeakMap()
  const attachmentRecoveryWarnings = new WeakMap()

  const recordAttachments = (session, refs) => {
    if (!session || !Array.isArray(refs) || refs.length === 0) return
    store.recordAttachments(session, refs)
  }


  // Synchronous lookup is cache-only. Projected short handles first warm this
  // cache from current derived messages and must not trigger historical I/O.
  const lookupAttachment = (session, id) => {
    if (!primitiveLookup) return undefined
    return primitiveLookup(session, id)
  }

  const recoverAttachmentsFromEvents = (session, ids, events) => {
    const found = new Map()
    if (!Array.isArray(events) || events.length === 0 || typeof core.collectEventAttachmentRefs !== 'function') {
      return found
    }
    const wanted = new Set(ids.map((id) => String(id)))
    for (const ref of core.collectEventAttachmentRefs(events)) {
      if (!ref) continue
      const id = String(ref.attachmentId ?? ref.id)
      if (wanted.has(id) && !found.has(id)) found.set(id, ref)
    }
    if (found.size > 0) store.recordAttachments(session, [...found.values()])
    return found
  }

  const warnAttachmentRecoveryFailure = (session, id, error) => {
    const message = boundedMessage(error)
    const key = `${String(id)}:${message}`
    if (attachmentRecoveryWarnings.get(session) === key) return
    attachmentRecoveryWarnings.set(session, key)
    logger?.warn?.(
      'vision-router: session attachment recovery failed id=%s error=%s',
      String(id),
      message,
    )
  }

  const resolveAttachments = async (session, ids) => {
    const requested = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))]
    const resolved = new Map()
    const missing = []
    for (const id of requested) {
      const cached = lookupAttachment(session, id)
      if (cached !== undefined) resolved.set(id, cached)
      else missing.push(id)
    }
    if (missing.length === 0 || session === undefined) return resolved

    let events
    if (typeof readSessionLog === 'function') {
      let result
      try {
        result = await readSessionLog(session)
      } catch (error) {
        warnAttachmentRecoveryFailure(session, missing[0], error)
        return resolved
      }
      if (result?.supported === true) {
        attachmentRecoveryWarnings.delete(session)
        events = result.events
      } else if (result?.supported !== false) {
        warnAttachmentRecoveryFailure(
          session,
          missing[0],
          new Error('Session log reader returned an invalid capability result'),
        )
        return resolved
      }
    }

    // Historical/partial Hosts without SessionQuery keep the released fallback.
    // Public rc8+ Hosts use readSessionLog above and never touch sync history.
    if (events === undefined) events = legacySessionEvents(session)
    const recovered = recoverAttachmentsFromEvents(session, missing, events)
    for (const [id, ref] of recovered) resolved.set(id, ref)
    return resolved
  }

  const resolveAttachment = async (session, id) => {
    return (await resolveAttachments(session, [id])).get(String(id))
  }

  const pendingSurfaceScan = (scans, session) => {
    if (!session) return undefined
    const nodes = surfaceNodes(session)
    if (!nodes || nodes.length === 0) return undefined
    let scan = scans.get(session)
    if (!scan) {
      scan = { count: 0 }
      scans.set(session, scan)
    }
    // Compaction/resume may shrink/rebuild the surface. Reset the incremental
    // cursor rather than assuming old indices still refer to the new surface.
    if (scan.count > nodes.length) scan.count = 0
    const count = nodes.length
    const seqs = nodes.slice(scan.count)
    if (seqs.length === 0) return undefined
    return {
      seqs,
      advance() {
        if (scan.count < count) scan.count += 1
      },
    }
  }

  const warnRepairReadFailure = (session, seq, error) => {
    const message = boundedMessage(error)
    const previous = repairReadWarnings.get(session)
    if (previous?.seq === seq && previous.message === message) return
    repairReadWarnings.set(session, { seq, message })
    logger?.warn?.(
      'vision-router: session surface event read failed seq=%s error=%s',
      seq,
      message,
    )
  }

  const eventForSurfaceRepair = async (session, seq) => {
    // A live Session already owns the exact event array behind its surface.
    // Prefer its O(1) point lookup before SessionQuery: current DSH SessionQuery
    // snapshots/clones the whole live session before returning one event, so
    // repeating readEvent() for every surface node becomes quadratic (#524).
    if (typeof session?.eventAt === 'function') {
      let event
      try {
        event = session.eventAt(seq)
      } catch (error) {
        warnRepairReadFailure(session, seq, error)
        return { readable: false }
      }
      if (event && typeof event === 'object') {
        repairReadWarnings.delete(session)
        return { readable: true, event }
      }
    }

    if (typeof readSessionEvent === 'function') {
      let result
      try {
        result = await readSessionEvent(session, seq)
      } catch (error) {
        warnRepairReadFailure(session, seq, error)
        return { readable: false }
      }
      if (result?.supported === true) {
        repairReadWarnings.delete(session)
        return { readable: true, event: result.event }
      }
      if (result?.supported !== false) {
        warnRepairReadFailure(session, seq, new Error('Session event reader returned an invalid capability result'))
        return { readable: false }
      }
    }

    // Isolated/partial Hosts that do not expose SessionQuery retain the released
    // Session-local compatibility path. Supported production Hosts use the
    // bounded async reader above and never silently fall back after a read error.
    const events = legacySessionEvents(session)
    if (!events) return { readable: false }
    return { readable: true, event: events[seq] }
  }

  const keepToolResultImages = () => {
    const policy = currentSessionSurfacePolicy(
      typeof config === 'function' ? config() : config,
    )
    return policy.ownership === 'native-image' || policy.ownership === 'vision-router-owned'
  }

  const replacementIntent = (session, seq) => {
    const intent = sessionSurfaceReplacementIntent(session, seq)
    if (intent !== undefined) return intent
    if (!unsupportedSurfaceContracts.has(session)) {
      unsupportedSurfaceContracts.add(session)
      logger?.warn?.(
        'vision-router: skipping durable session surface repair for unsupported Session format version=%s',
        session?.header?.version ?? 'unknown',
      )
    }
    return undefined
  }

  const repairToolResultSurface = async (session) => {
    if (typeof session?.append !== 'function') return 0
    const scan = pendingSurfaceScan(toolSurfaceScans, session)
    if (!scan || typeof core.planToolResultImageShadows !== 'function') return 0
    const preserve = keepToolResultImages()
    let repaired = 0
    for (const seq of scan.seqs) {
      const read = await eventForSurfaceRepair(session, seq)
      if (!read.readable) break
      // A readable node is settled for this repair pass even when it needs no
      // replacement or append later fails; only an unread node remains pending.
      scan.advance()
      const events = []
      events[seq] = read.event
      const plans = core.planToolResultImageShadows(events, [seq], () => !preserve)
      for (const plan of plans) {
        try {
          const intent = replacementIntent(session, plan.seq)
          if (intent === undefined) continue
          await session.append(
            'tool/result',
            { ...plan.event.data, message: plan.message },
            intent,
          )
          repaired += 1
        } catch (error) {
          logger?.warn?.(
            'vision-router: session tool-result surface repair failed seq=%s error=%s',
            plan.seq,
            boundedMessage(error),
          )
        }
      }
    }
    return repaired
  }

  const repairGuardStopSurface = async (session) => {
    if (typeof session?.append !== 'function') return 0
    const scan = pendingSurfaceScan(guardSurfaceScans, session)
    if (!scan || typeof core.planGuardStopShadows !== 'function') return 0
    let repaired = 0
    for (const seq of scan.seqs) {
      const read = await eventForSurfaceRepair(session, seq)
      if (!read.readable) break
      scan.advance()
      const events = []
      events[seq] = read.event
      const plans = core.planGuardStopShadows(events, [seq])
      for (const plan of plans) {
        try {
          const intent = replacementIntent(session, plan.seq)
          if (intent === undefined) continue
          await session.append(
            'user/message',
            plan.data,
            intent,
          )
          repaired += 1
        } catch (error) {
          logger?.warn?.(
            'vision-router: session guard-stop surface repair failed seq=%s error=%s',
            plan.seq,
            boundedMessage(error),
          )
        }
      }
    }
    return repaired
  }

  const prepareDecision = async (payload, decision) => {
    const session = payload?.agent?.session
    if (!session) return decision

    const messages = messagesFrom(payload, decision)
    if (typeof core.rewriteImageBlocks === 'function') {
      const found = core.rewriteImageBlocks(messages)
      if (Array.isArray(found?.attachments) && found.attachments.length > 0) {
        store.recordAttachments(session, found.attachments)
      }
    }
    await repairToolResultSurface(session)
    await repairGuardStopSurface(session)
    return decision
  }

  return Object.freeze({
    recordAttachments,
    lookupAttachment,
    resolveAttachment,
    resolveAttachments,
    repairToolResultSurface,
    repairGuardStopSurface,
    prepareDecision,
  })
}

/**
 * Intercept core's pre-step registration and decorate only its downstream
 * `next()` result. Production passes `options.index`; direct/test callers get
 * an isolated index/store unless they explicitly provide `options.stateStore`.
 */
export function installSessionVisionIndexBoundary(ctx, config, core, options = {}) {
  if (!isObject(ctx)) return ctx
  const index = options.index ?? createSessionVisionIndex({
    stateStore: options.stateStore,
    core,
    config: () => {
      try {
        const settings = ctx?.get?.('settings')
        const live = settings?.get?.('vision-router')
        if (live && typeof live === 'object' && !Array.isArray(live)) return live
      } catch {}
      return config
    },
    logger: options.logger,
  })

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(
            target,
            event,
            async function sessionVisionIndexedPreStep(payload, next) {
              const indexedNext = typeof next === 'function'
                ? async (...args) => {
                    const decision = await next(...args)
                    return index.prepareDecision(payload, decision)
                  }
                : next
              return handler.call(this, payload, indexedNext)
            },
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
