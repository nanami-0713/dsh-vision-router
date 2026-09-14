import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROUND2_CASES, validateRound2Corpus } from '../quality/vision-round2/corpus.mjs'
import { scoreRound2Result, summarizeRound2Results } from '../quality/vision-round2/scorer.mjs'

test('Round 2 seed corpus is small, balanced and deterministic', () => {
  const summary = validateRound2Corpus()
  assert.equal(summary.total, 36)
  assert.deepEqual(summary.counts, {
    text_precision: 8,
    multi_image_identity: 6,
    small_target: 6,
    ui_state: 6,
    uncertainty: 5,
    relevance_noise: 5,
  })
})

test('exact text scoring preserves case and confusable characters', () => {
  assert.equal(scoreRound2Result({ id: 'text-confusable-01', answer: 'O0I1l-7Q2' }).pass, true)
  assert.equal(scoreRound2Result({ id: 'text-confusable-01', answer: 'o0i1l-7q2' }).pass, false)
  assert.equal(scoreRound2Result({ id: 'text-confusable-01', answer: 'O0I11-7Q2' }).pass, false)
})

test('report keeps correctness separate from advisory tool-call efficiency', () => {
  const report = summarizeRound2Results([
    { id: 'ui-state-01', answer: 'ON', toolCalls: 9 },
    { id: 'ui-state-02', answer: 'ON', toolCalls: 1 },
  ])
  assert.equal(report.passed, 1)
  assert.equal(report.failed, 1)
  assert.equal(report.extraToolCallCases, 1)
  assert.equal(report.categories.ui_state.total, 2)
  assert.equal(report.categories.ui_state.failed, 1)
  assert.equal(report.missing.length, ROUND2_CASES.length - 2)
})

test('renderer produces PNG fixtures and manifest without changing the corpus', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-quality-r2-'))
  try {
    const run = spawnSync(process.execPath, ['quality/vision-round2/render-fixtures.mjs', root], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
    assert.equal(manifest.cases.length, 36)
    assert.deepEqual(manifest.cases[8].images.length, 2)
    const png = await readFile(path.join(root, manifest.cases[0].images[0]))
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('run template has exactly one blank result row per case', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-quality-r2-template-'))
  try {
    const target = path.join(root, 'results.template.jsonl')
    const run = spawnSync(process.execPath, ['quality/vision-round2/make-run-template.mjs', target], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const rows = (await readFile(target, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(rows.length, 36)
    assert.deepEqual(rows.map((row) => row.id), ROUND2_CASES.map((item) => item.id))
    assert.equal(rows.every((row) => row.answer === '' && row.toolCalls === null), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
