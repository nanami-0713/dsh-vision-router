import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dvrRoot = path.resolve(here, '..')
const dshRoot = path.resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

const expectedVersion = String(process.env.DSH_EXPECTED_VERSION || '').trim()
const expectedCommit = String(process.env.DSH_EXPECTED_COMMIT || '').trim()
if (!expectedVersion) throw new Error('DSH_EXPECTED_VERSION is required')
if (!expectedCommit) throw new Error('DSH_EXPECTED_COMMIT is required')

const actualCommit = execFileSync('git', ['-C', dshRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.match(expectedCommit, /^[0-9a-f]{40}$/)
assert.equal(actualCommit, expectedCommit)

const manifest = JSON.parse(await readFile(path.join(dshRoot, 'package.json'), 'utf8'))
assert.equal(manifest.version, expectedVersion)
assert.equal(manifest.packageManager, 'pnpm@11.7.0')

const [
  configEditorSource,
  settingsSource,
  sessionTypesSource,
  v4AdmissionSource,
  v3ToV4Source,
  webBundleSource,
] = await Promise.all([
  readFile(path.join(dshRoot, 'packages/boot/config-editor/src/index.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/settings/settings/src/index.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/core/session/src/types.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/session/session-format-v3-to-v4/src/message-sources.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/session/session-format-v3-to-v4/src/sources.ts'), 'utf8'),
  readFile(path.join(dshRoot, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8'),
])

// 0.1.7 ordinary plugin configuration is profile-owned. ConfigEditor is the
// durable complete-config write seam and validates/reconciles through Loader.
assert.match(configEditorSource, /export class ConfigEditor extends Service/)
assert.match(configEditorSource, /async edit\(/)
assert.match(configEditorSource, /resolveConfig\(fiber\.runtime/)
assert.match(configEditorSource, /writeFileAtomic\(/)
assert.match(configEditorSource, /reconcileProfilePatches\(/)

// SettingsForms is intentionally only a projection/editor for volatile fields.
// DVR's ordinary Config must therefore not be routed through mutate().
assert.match(settingsSource, /export class SettingsForms extends Service/)
assert.match(settingsSource, /static inject = \['configEditor', 'profileContext'\]/)
assert.match(settingsSource, /const form = volatileForm\(schema\)/)
assert.match(settingsSource, /Config field .* is not volatile/)
assert.doesNotMatch(settingsSource, /\bregister\s*\(namespace/)

// Session v4 is the exact durable writer contract in the 0.1.7 train.
assert.match(sessionTypesSource, /export const SESSION_FORMAT_VERSION = 4/)
assert.match(v4AdmissionSource, /value\['kind'\] === 'plugin'/)
assert.match(v4AdmissionSource, /format v4 message requires a producer-owned source kind/)
assert.match(v3ToV4Source, /return `plugin:\$\{plugin\}`/)

// #448 remains a DVR-owned overlay at this exact 0.1.7 release: upstream still
// mounts modules without an explicit webServer activation dependency.
assert.match(webBundleSource, /- id: modules\s+name: '@deepseek-ai\/dsh-client-modules'/)
assert.doesNotMatch(webBundleSource, /- id: modules\s+name: '@deepseek-ai\/dsh-client-modules'\s+inject: \[[^\]]*webServer/)

// Exercise DVR's own format selector against the exact source generation fact.
const sourceCompat = await import(pathToFileURL(path.join(dvrRoot, 'lib/session-message-source-compat.js')).href)
assert.deepEqual(sourceCompat.visionRouterMessageSource({ header: { version: 3 } }), {
  kind: 'plugin', plugin: 'dsh-vision-router',
})
assert.deepEqual(sourceCompat.visionRouterMessageSource({ header: { version: 4 } }), {
  kind: 'plugin:dsh-vision-router',
})

console.log(JSON.stringify({
  ok: true,
  dsh: expectedVersion,
  commit: actualCommit,
  platform: process.platform,
  node: process.version,
  sessionFormat: 4,
  settingsOwner: 'configEditor',
  modulesOverlay: 'shim-required',
}))
