#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { summarizeRound2Results } from './scorer.mjs'

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--')
const source = cliArgs[0]
if (!source) throw new Error('usage: node quality/vision-round2/report-results.mjs <results.jsonl>')
const rows = (await readFile(source, 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try { return JSON.parse(line) } catch { throw new Error(`invalid JSONL at line ${index + 1}`) }
  })
const report = summarizeRound2Results(rows)
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.failed > 0 || report.missing.length > 0 ? 1 : 0
