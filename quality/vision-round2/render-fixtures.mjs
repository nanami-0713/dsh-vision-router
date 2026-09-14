#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ROUND2_CASES, ROUND2_BASELINE_VERSION, ROUND2_SUITE_REVISION, validateRound2Corpus } from './corpus.mjs'

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--')
const outDir = path.resolve(cliArgs[0] || '.artifacts/vision-quality-round2')
validateRound2Corpus()
await mkdir(outDir, { recursive: true })
const manifest = []
for (const item of ROUND2_CASES) {
  const imagePaths = []
  for (let index = 0; index < item.images.length; index += 1) {
    const image = item.images[index]
    const file = `${item.id}-${index + 1}-${image.name}.png`.replace(/[^A-Za-z0-9._-]/g, '_')
    const target = path.join(outDir, file)
    await sharp(Buffer.from(image.svg, 'utf8'), { failOn: 'none' }).png().toFile(target)
    imagePaths.push(file)
  }
  manifest.push({ id: item.id, category: item.category, question: item.question, images: imagePaths, maxUsefulCalls: item.maxUsefulCalls })
}
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ suiteRevision: ROUND2_SUITE_REVISION, baselineVersion: ROUND2_BASELINE_VERSION, cases: manifest }, null, 2) + '\n')
console.log(`rendered ${manifest.length} Round 2 cases to ${outDir}`)
