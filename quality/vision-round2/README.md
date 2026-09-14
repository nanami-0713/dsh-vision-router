# Vision Agent Quality Round 2 baseline

This lab measures user-visible vision failures before any 2.2 runtime behavior changes. It is intentionally small, deterministic, and failure-oriented.

## Scope

The seed corpus contains 36 cases across six categories: exact text/number reading, multi-image identity, small targets, UI state, uncertainty, and relevance/noise resistance. Fixtures are generated from deterministic SVG and rendered to PNG.

There is no weighted quality score and no LLM judge. Each case has one or more exact accepted answers. `toolCalls` is recorded only as a side metric; extra calls never turn a correct answer into a failure or a wrong answer into a pass.

Exact-answer matching is case-sensitive after trimming leading/trailing whitespace. This is deliberate so confusable characters such as `O/0`, `I/l`, and exact codes remain measurable.

## Run

```sh
pnpm quality:round2:render
pnpm quality:round2:template
```

Use the generated PNG files and `manifest.json` with a clean DSH profile running the version being measured. For every case, ask the manifest question against exactly the listed image(s), then fill one JSONL row:

```json
{"id":"text-confusable-01","answer":"O0I1l-7Q2","toolCalls":2}
```

`toolCalls` is optional when the host trace is unavailable. Do not manually correct, normalize, or reinterpret the model answer before recording it.

Generate the deterministic report with:

```sh
pnpm quality:round2:report -- .artifacts/vision-quality-round2/results.jsonl
```

The report exposes raw pass/fail counts by failure category, missing cases, and the number of cases exceeding their advisory `maxUsefulCalls`. It does not collapse those facts into a synthetic score.

## Change policy for 2.2

The first reference run is v2.1.7. Production changes should target an observed failure class and be compared against the same corpus. New fixtures should represent a distinct real failure mode, not inflate the suite with easy variants.
