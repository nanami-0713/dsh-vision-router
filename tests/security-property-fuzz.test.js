import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

import {
  MAX_REMOTE_MUTATION_DEPTH,
  MAX_REMOTE_MUTATION_NODES,
  MAX_REMOTE_MUTATION_STRING_BYTES,
  MAX_REMOTE_MUTATION_VALUE_BYTES,
  MAX_RUNTIME_EXTRA_VISION_MODELS,
  MAX_RUNTIME_FALLBACKS_PER_ROW,
  MAX_RUNTIME_MODEL_ID_CHARS,
  MAX_RUNTIME_PROVIDER_ROWS,
  MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER,
  MAX_RUNTIME_WRAPPED_PROVIDER_ROWS,
  normalizeRuntimeVisionConfig,
  remoteMutationValueBudgetError,
} from '../lib/runtime-config-normalizer.js'
import {
  WEB_ROUTE_REMOTE_CAPABILITY,
  isLoopbackAddress,
  webRouteRemoteCapability,
} from '../lib/web-capability-boundary.js'
import { wireSessionAffinityId } from '../lib/session-affinity.js'

const RUNS = Math.max(100, Math.min(5_000, Number(process.env.DVR_PROPERTY_FUZZ_CASES) || 500))
const seedValue = Number(process.env.DVR_PROPERTY_FUZZ_SEED)
const PROPERTY_OPTIONS = {
  numRuns: RUNS,
  ...(Number.isFinite(seedValue) ? { seed: Math.trunc(seedValue) } : {}),
}

const identifier = fc.string({ maxLength: MAX_RUNTIME_MODEL_ID_CHARS + 64 })
const scalar = fc.oneof(fc.string({ maxLength: 1024 }), fc.integer(), fc.boolean(), fc.constant(null))
const providerRow = fc.record({
  provider: identifier,
  model: identifier,
  fallbacks: fc.array(fc.oneof(identifier, scalar), { maxLength: MAX_RUNTIME_FALLBACKS_PER_ROW * 3 }),
}, { withDeletedKeys: true })

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

test('property fuzz: runtime config normalization never exceeds executor resource bounds', () => {
  fc.assert(fc.property(
    fc.record({
      providers: fc.array(fc.oneof(providerRow, scalar), { maxLength: MAX_RUNTIME_PROVIDER_ROWS * 3 }),
      fallbacks: fc.array(fc.oneof(identifier, scalar), { maxLength: MAX_RUNTIME_FALLBACKS_PER_ROW * 3 }),
      extraVisionModels: fc.array(fc.oneof(identifier, scalar), { maxLength: MAX_RUNTIME_EXTRA_VISION_MODELS * 2 }),
      wrappedProviders: fc.array(fc.record({
        provider: identifier,
        models: fc.array(fc.oneof(identifier, scalar), { maxLength: MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER * 2 }),
      }, { withDeletedKeys: true }), { maxLength: MAX_RUNTIME_WRAPPED_PROVIDER_ROWS * 3 }),
    }, { withDeletedKeys: true }),
    (input) => {
      const normalized = normalizeRuntimeVisionConfig(input)
      assert.ok(normalized.providers.length <= MAX_RUNTIME_PROVIDER_ROWS)
      assert.ok(normalized.fallbacks.length <= MAX_RUNTIME_FALLBACKS_PER_ROW)
      assert.ok(normalized.extraVisionModels.length <= MAX_RUNTIME_EXTRA_VISION_MODELS)
      assert.ok(normalized.wrappedProviders.length <= MAX_RUNTIME_WRAPPED_PROVIDER_ROWS)
      for (const row of normalized.providers) {
        assert.ok(row.provider.length <= MAX_RUNTIME_MODEL_ID_CHARS)
        assert.ok(row.model.length <= MAX_RUNTIME_MODEL_ID_CHARS)
        assert.ok(row.fallbacks.length <= MAX_RUNTIME_FALLBACKS_PER_ROW)
      }
      for (const row of normalized.wrappedProviders) {
        assert.ok(row.provider.length <= MAX_RUNTIME_MODEL_ID_CHARS)
        assert.ok(row.models.length <= MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER)
        for (const model of row.models) assert.ok(model.length <= MAX_RUNTIME_MODEL_ID_CHARS)
      }
    },
  ), PROPERTY_OPTIONS)
})

test('property fuzz: remote mutation admission is total and bounded for arbitrary JSON trees', () => {
  const jsonValue = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: 'small' },
      fc.string({ maxLength: 90_000 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('value'), { maxLength: 48 }),
      fc.dictionary(fc.string({ maxLength: 64 }), tie('value'), { maxKeys: 48 }),
    ),
  })).value

  fc.assert(fc.property(jsonValue, (value) => {
    const result = remoteMutationValueBudgetError(value)
    assert.ok(result === undefined || typeof result === 'string')
    if (result === undefined) {
      const stack = [{ value, depth: 0 }]
      let nodes = 0
      let approximateBytes = 0
      while (stack.length > 0) {
        const current = stack.pop()
        assert.ok(current.depth <= MAX_REMOTE_MUTATION_DEPTH)
        nodes += 1
        assert.ok(nodes <= MAX_REMOTE_MUTATION_NODES)
        const item = current.value
        if (typeof item === 'string') {
          const bytes = utf8Bytes(item)
          assert.ok(bytes <= MAX_REMOTE_MUTATION_STRING_BYTES)
          approximateBytes += bytes
        } else if (Array.isArray(item)) {
          for (const child of item) stack.push({ value: child, depth: current.depth + 1 })
        } else if (item && typeof item === 'object') {
          for (const [key, child] of Object.entries(item)) {
            approximateBytes += utf8Bytes(key)
            stack.push({ value: child, depth: current.depth + 1 })
          }
        } else {
          approximateBytes += 16
        }
      }
      assert.ok(approximateBytes <= MAX_REMOTE_MUTATION_VALUE_BYTES + nodes * 16)
    }
  }), PROPERTY_OPTIONS)
})

test('property fuzz: undeclared DVR web methods stay fail-closed remotely', () => {
  fc.assert(fc.property(
    fc.string({ maxLength: 160 }),
    fc.string({ maxLength: 24 }),
    (suffix, method) => {
      const path = `/_dsh/vision-router/property-${suffix}`
      assert.equal(webRouteRemoteCapability(path, method), WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY)
    },
  ), PROPERTY_OPTIONS)
})

test('property fuzz: IPv4 loopback classification depends only on a valid 127/8 transport address', () => {
  fc.assert(fc.property(
    fc.tuple(
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
    ),
    ([a, b, c, d]) => {
      assert.equal(isLoopbackAddress(`${a}.${b}.${c}.${d}`), a === 127)
      assert.equal(isLoopbackAddress(`::ffff:${a}.${b}.${c}.${d}`), a === 127)
    },
  ), PROPERTY_OPTIONS)
})

test('property fuzz: session affinity projection never admits whitespace/control injection', () => {
  fc.assert(fc.property(fc.string({ maxLength: 900 }), (candidate) => {
    const projected = wireSessionAffinityId(candidate)
    if (projected === undefined) return
    assert.equal(projected, candidate)
    assert.ok(projected.length <= 512)
    assert.match(projected, /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/)
  }), PROPERTY_OPTIONS)
})
