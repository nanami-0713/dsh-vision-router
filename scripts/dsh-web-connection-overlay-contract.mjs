import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WEB_CONNECTION_ROW_ID = 'connection'
export const WEB_CONNECTION_PACKAGE = '@deepseek-ai/dsh-client-connection'
export const WEB_RUNTIME_SERVICE = 'webRuntime'
export const WEB_SERVER_SERVICE = 'webServer'

function result(status, reason, row, inject = []) {
  return Object.freeze({ status, reason, row, inject: Object.freeze([...inject]) })
}

export function classifyWebConnectionRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  const matches = list.filter((row) => row && row.id === WEB_CONNECTION_ROW_ID)
  if (matches.length !== 1) {
    return result(
      'dangerous-drift',
      `expected exactly one official Web ${WEB_CONNECTION_ROW_ID} row, found ${matches.length}`,
      matches[0],
    )
  }

  const row = matches[0]
  if (row.name !== WEB_CONNECTION_PACKAGE) {
    return result(
      'dangerous-drift',
      `official Web ${WEB_CONNECTION_ROW_ID} row changed identity to ${String(row.name)}`,
      row,
    )
  }
  if (!Array.isArray(row.inject) || row.inject.some((value) => typeof value !== 'string' || value === '')) {
    return result('dangerous-drift', 'official Web connection inject field is no longer a string array', row)
  }

  const inject = [...new Set(row.inject)]
  if (!inject.includes(WEB_RUNTIME_SERVICE)) {
    return result(
      'dangerous-drift',
      `official Web connection row no longer owns ${WEB_RUNTIME_SERVICE}: ${inject.join(', ')}`,
      row,
      inject,
    )
  }
  if (inject.includes(WEB_SERVER_SERVICE)) {
    return result(
      'retire-ready',
      inject.length === 2
        ? 'official Web connection row now owns both webRuntime and webServer'
        : `official Web connection row now owns webServer plus ${inject.length - 2} additional activation dependency/dependencies`,
      row,
      inject,
    )
  }
  if (inject.length === 1) {
    return result('shim-required', 'official Web connection row still owns only webRuntime', row, inject)
  }
  return result(
    'dangerous-drift',
    `official Web connection row gained activation dependencies without webServer: ${inject.join(', ')}`,
    row,
    inject,
  )
}

export async function inspectDshWebConnectionOverlay(dshRoot) {
  const root = path.resolve(dshRoot || '')
  if (!dshRoot) throw new Error('DSH_SOURCE_ROOT is required')
  const appBootUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/index.ts')).href
  const profileUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/profile.ts')).href
  const [{ loadOverlayPatches }, { composeEntries }] = await Promise.all([
    import(appBootUrl),
    import(profileUrl),
  ])
  const patchPath = path.join(root, 'packages/bundle/web-app/cordis.patch.yml')
  const patches = loadOverlayPatches('dvr connection/webServer overlay contract', patchPath)
  const insertedRows = patches.flatMap((patch) => Array.isArray(patch?.insert) ? patch.insert : [])
  const classified = classifyWebConnectionRows(insertedRows)
  if (classified.status !== 'shim-required') return classified

  const dvrRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
  const dvrPatches = loadOverlayPatches(
    'dvr connection/webServer overlay contract',
    path.join(dvrRoot, 'cordis.patch.yml'),
  )
  const composed = composeEntries([patches, dvrPatches])
  const effective = composed.find((row) => row?.id === WEB_CONNECTION_ROW_ID)
  if (!effective) {
    return result('dangerous-drift', 'DVR overlay removed the official Web connection row', effective)
  }

  const { inject: officialInject, ...officialStable } = classified.row
  const { inject: effectiveInject, ...effectiveStable } = effective
  if (!isDeepStrictEqual(effectiveStable, officialStable)) {
    return result(
      'dangerous-drift',
      'DVR overlay changed official Web connection fields other than inject',
      effective,
      effectiveInject,
    )
  }
  const expectedInject = [...officialInject, WEB_SERVER_SERVICE]
  if (!isDeepStrictEqual(effectiveInject, expectedInject)) {
    return result(
      'dangerous-drift',
      `DVR overlay produced unexpected connection inject dependencies: ${String(effectiveInject)}`,
      effective,
      effectiveInject,
    )
  }
  return classified
}

async function main() {
  const dshRoot = String(process.env.DSH_SOURCE_ROOT || '').trim()
  const expected = String(process.env.DSH_CONNECTION_WEBSERVER_EXPECTED || '').trim()
  const inspected = await inspectDshWebConnectionOverlay(dshRoot)
  const payload = {
    ok: inspected.status !== 'dangerous-drift' && (!expected || inspected.status === expected),
    status: inspected.status,
    expected: expected || undefined,
    reason: inspected.reason,
    inject: inspected.inject,
  }
  console.log(JSON.stringify(payload))

  if (inspected.status === 'dangerous-drift') {
    throw new Error(`DSH Web connection compatibility overlay is unsafe: ${inspected.reason}`)
  }
  if (expected && inspected.status !== expected) {
    if (inspected.status === 'retire-ready') {
      throw new Error(
        `DSH Web now owns connection -> webServer; retire DVR's compatibility overlay before admitting this Host train (${inspected.reason})`,
      )
    }
    throw new Error(`expected DSH Web connection state ${expected}, got ${inspected.status}: ${inspected.reason}`)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invoked) await main()
