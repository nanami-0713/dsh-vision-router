#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROUND2_CASES } from './corpus.mjs'

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--')
const target = path.resolve(cliArgs[0] || '.artifacts/vision-quality-round2/results.template.jsonl')
await mkdir(path.dirname(target), { recursive: true })
const lines = ROUND2_CASES.map((item) => JSON.stringify({ id: item.id, answer: '', toolCalls: null }))
await writeFile(target, `${lines.join('\n')}\n`)
console.log(`wrote ${lines.length} result rows to ${target}`)
