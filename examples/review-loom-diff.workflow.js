export const meta = {
  name: 'review-loom-diff',
  description: 'Multi-dimension review of the current diff against loom invariants, adversarially verified',
  phases: [
    { title: 'Scope',  detail: 'list changed files + hunks' },
    { title: 'Review', detail: 'one agent per review dimension' },
    { title: 'Verify', detail: 'adversarially refute each finding' },
    { title: 'Synthesize', detail: 'dedupe + rank surviving findings' },
  ],
}

// ---- Phase 1: scope the diff (cheap, single agent) ----
phase('Scope')
const DIFF_SCHEMA = {
  type: 'object',
  required: ['files'],
  properties: {
    files: { type: 'array', items: {
      type: 'object', required: ['path', 'summary'],
      properties: { path: {type: 'string'}, summary: {type: 'string'} },
    }},
  },
}
const scope = await agent(
  'Run `git diff main...HEAD --stat` then read the changed files. ' +
  'Return each changed file with a one-line summary of what changed.',
  { label: 'scope', schema: DIFF_SCHEMA }
)
if (!scope.files.length) return { findings: [], note: 'empty diff' }
log(`Reviewing ${scope.files.length} changed files`)

// ---- Phase 2 + 3 pipelined: each dimension verifies as soon as it's done ----
const fileList = scope.files.map(f => `${f.path}: ${f.summary}`).join('\n')

const DIMENSIONS = [
  { key: 'invariants', prompt:
      'Review the diff for violations of loom\'s two load-bearing invariants: ' +
      '(1) markdown is the source of truth, SQLite is derived — no DB-only state; ' +
      '(2) the filesystem path encodes the qid. Flag any persisted DB-only state ' +
      'or path/qid divergence.' },
  { key: 'apply_record', prompt:
      'Check whether any change to index.py risks the apply_record UPSERT contract: ' +
      'DELETE-then-INSERT on the items row cascades and wipes incoming dependency edges. ' +
      'Flag any regression toward delete-then-insert.' },
  { key: 'mutator', prompt:
      'Verify every new/changed Item mutator follows the 5-step contract in items.py ' +
      '(read → mutate frontmatter → atomic dump → rebuild IndexRecord → assign self._record). ' +
      'Flag mutators that skip re-indexing or mutate shared in-memory state.' },
  { key: 'tests', prompt:
      'Identify changed behavior that lacks a corresponding pytest test in tests/, ' +
      'especially e2e coverage of both library + CLI surfaces.' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: {
      type: 'object',
      required: ['title', 'file', 'severity', 'detail'],
      properties: {
        title:    { type: 'string' },
        file:     { type: 'string' },
        severity: { type: 'string', enum: ['low', 'med', 'high'] },
        detail:   { type: 'string' },
      },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason:  { type: 'string' },
  },
}

// pipeline: dimension A's findings verify while dimension B is still reviewing
const reviewed = await pipeline(
  DIMENSIONS,
  // stage 1 — review one dimension
  d => agent(
    `${d.prompt}\n\nChanged files:\n${fileList}\n\nRead the diff and the files as needed.`,
    { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }
  ),
  // stage 2 — adversarially verify each finding from that dimension (3 skeptics, majority refute kills it)
  (review, dim) => parallel(review.findings.map(f => () =>
    parallel(Array.from({ length: 3 }, () => () =>
      agent(
        `Try to REFUTE this review finding. Default to refuted=true if uncertain.\n` +
        `Finding: ${f.title}\nFile: ${f.file}\nClaim: ${f.detail}`,
        { label: `verify:${dim.key}:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      )
    )).then(votes => {
      const live = votes.filter(Boolean)
      const refuted = live.filter(v => v.refuted).length > live.length / 2
      return refuted ? null : f
    })
  ))
)

// ---- Phase 4: synthesize (barrier is implicit — pipeline already returned everything) ----
phase('Synthesize')
const survivors = reviewed.flat().filter(Boolean)
const ranked = survivors.sort((a, b) =>
  ({ high: 0, med: 1, low: 2 }[a.severity] - { high: 0, med: 1, low: 2 }[b.severity]))

return {
  reviewed_files: scope.files.length,
  confirmed: ranked,
  dropped_by_verify: reviewed.flat().filter(x => x === null).length,
}
