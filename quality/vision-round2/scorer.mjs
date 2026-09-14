import { ROUND2_CASES, ROUND2_CATEGORIES } from './corpus.mjs'

const byId = new Map(ROUND2_CASES.map((item) => [item.id, item]))

function trimmed(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

export function scoreRound2Result(result) {
  const id = String(result?.id ?? '').trim()
  const item = byId.get(id)
  if (!item) throw new Error(`unknown Round 2 case id: ${id || '<empty>'}`)
  const actual = trimmed(result?.answer)
  const expected = item.expected.map(trimmed)
  const pass = expected.includes(actual)
  const toolCalls = Number.isFinite(Number(result?.toolCalls)) ? Math.max(0, Math.floor(Number(result.toolCalls))) : undefined
  return {
    id,
    category: item.category,
    pass,
    actual,
    expected,
    ...(toolCalls === undefined ? {} : {
      toolCalls,
      extraToolCalls: Math.max(0, toolCalls - item.maxUsefulCalls),
    }),
  }
}

export function summarizeRound2Results(results) {
  if (!Array.isArray(results)) throw new TypeError('Round 2 results must be an array')
  const scored = results.map(scoreRound2Result)
  const seen = new Set(scored.map((item) => item.id))
  if (seen.size !== scored.length) throw new Error('Round 2 results contain duplicate case ids')
  const categories = Object.fromEntries(ROUND2_CATEGORIES.map((category) => [category, { total: 0, passed: 0, failed: 0 }]))
  let extraToolCallCases = 0
  for (const row of scored) {
    const bucket = categories[row.category]
    bucket.total += 1
    if (row.pass) bucket.passed += 1
    else bucket.failed += 1
    if ((row.extraToolCalls ?? 0) > 0) extraToolCallCases += 1
  }
  return {
    total: scored.length,
    passed: scored.filter((row) => row.pass).length,
    failed: scored.filter((row) => !row.pass).length,
    missing: ROUND2_CASES.filter((item) => !seen.has(item.id)).map((item) => item.id),
    extraToolCallCases,
    categories,
    failures: scored.filter((row) => !row.pass),
  }
}
