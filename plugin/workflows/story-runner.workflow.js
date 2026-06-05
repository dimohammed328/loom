// story-runner.workflow.js — single-story runner for a loom story.
// Receives: args.story_qid, args.finalize ('pr' | 'merge', default 'pr').
//
// Phases:
//   Execute / Review / Validate — convergence loop (prepare)
//   Finalize                    — final validation, then open a PR (default) or
//                                 merge + push to main

export const meta = {
  name: 'story-runner',
  description: 'Single-story runner: build → review → validate convergence loop, then finalize (open a PR by default, or merge + push to main when requested)',
  phases: [
    { title: 'Execute',  detail: 'story-executor builds the story branch' },
    { title: 'Review',   detail: 'code-reviewer checks hygiene' },
    { title: 'Validate', detail: 'story-validator checks criteria and tests' },
    { title: 'Finalize', detail: 'final validation, then open a PR (default) or merge + push to main' },
  ],
}

// ── Schema constants ─────────────────────────────────────────────────────────
// EXECUTOR_SCHEMA  — story-executor (loom:story-executor) result
// REVIEWER_SCHEMA  — code-reviewer result
// VALIDATOR_SCHEMA — story-validator result
// MERGE_SCHEMA     — finalize-merge agent result
// PR_SCHEMA        — finalize-pr agent result

const EXECUTOR_SCHEMA = {
  type: 'object',
  required: ['story_qid', 'branch', 'worktree'],
  properties: {
    story_qid: { type: 'string' },
    branch:    { type: 'string' },
    worktree:  { type: 'string' },
    notes:     { type: 'string' },
  },
}

const REVIEWER_SCHEMA = {
  type: 'object',
  required: ['clean', 'findings'],
  properties: {
    clean:    { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'lines', 'detail'],
        properties: {
          title:  { type: 'string' },
          file:   { type: 'string' },
          lines:  { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
  },
}

const VALIDATOR_SCHEMA = {
  type: 'object',
  required: ['result', 'criteria'],
  properties: {
    result:   { type: 'string', enum: ['ok', 'failed'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'pass', 'evidence'],
        properties: {
          text:     { type: 'string' },
          pass:     { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['merged'],
  properties: {
    merged:    { type: 'boolean' },
    merge_sha: { type: ['string', 'null'] },
    conflict:  { type: 'string' },
  },
}

const PR_SCHEMA = {
  type: 'object',
  required: ['pr_url'],
  properties: { pr_url: { type: ['string', 'null'] } },
}

// ── Inputs ───────────────────────────────────────────────────────────────────

// args may arrive as an object or as a JSON-encoded string depending on the
// invoking harness; normalize to an object before reading fields.
const input = typeof args === 'string' ? JSON.parse(args) : (args ?? {})

const storyQid = input.story_qid
if (!storyQid) throw new Error('story_qid is required')
const finalize = input.finalize ?? 'pr'

// ── Helpers ──────────────────────────────────────────────────────────────────

// fileFixes(qid, fixes) — file a collated batch of fix-items ({title, body}) as
// new loom tasks on the story via a SINGLE agent, so the re-dispatched executor
// rediscovers them through `loom order` and resumes its worktree.
async function fileFixes(qid, fixes) {
  const createCmds = fixes
    .map(f => `loom -y task create --title ${JSON.stringify(f.title)} --body ${JSON.stringify(f.body)} ${qid}`)
    .join('\n')
  await agent(
    `Run each of these commands in order; confirm each exits 0:\n${createCmds}`,
    { label: `file-fixes:${qid}`, phase: 'Execute', agentType: 'loom:story-executor' }
  )
}

// prepare(qid, parentBranch) — build → review → validate convergence loop
// (≤3 attempts). Each attempt collates fix-items from BOTH the review and
// validate steps as local objects and files them via a single agent before
// re-dispatching the executor (which resumes its worktree and implements only
// the newly-filed tasks). Steps are tagged via opts.phase (NOT phase()) so the
// loop is safe to run concurrently. Returns { qid, executor, ok, open, attempts }:
//   ok:       true if the story converged
//   executor: the executor result on success, else null
//   open:     array of unmet-item titles (non-empty only when ok=false)
//   attempts: number of attempts made
async function prepare(qid, parentBranch) {
  const MAX_ATTEMPTS = 3
  let attempt = 0
  let open = []

  while (attempt < MAX_ATTEMPTS) {
    attempt++
    log(`[${qid}] prepare attempt ${attempt}/${MAX_ATTEMPTS}`)

    // Execute: story-executor builds the story branch.
    const executor = await agent(
      `story_qid=${qid} parent_branch=${parentBranch}`,
      { label: `executor:${qid}:${attempt}`, phase: 'Execute', agentType: 'loom:story-executor', schema: EXECUTOR_SCHEMA }
    )
    log(`[${qid}] executor done: branch=${executor.branch}`)

    const fixes = []  // [{ title, body }]

    // Review: code-reviewer checks hygiene.
    const review = await agent(
      `story_qid=${qid} branch=${executor.branch} trunk=${parentBranch} worktree=${executor.worktree}`,
      { label: `reviewer:${qid}:${attempt}`, phase: 'Review', agentType: 'loom:code-reviewer', schema: REVIEWER_SCHEMA }
    )
    if (!review.clean) {
      for (const f of review.findings) {
        fixes.push({
          title: `fix: ${f.title}`,
          body: `${f.detail}\n\nLocation: ${f.file}:${f.lines}`,
        })
      }
    }

    // Validate: story-validator checks criteria and tests.
    const validate = await agent(
      `story_qid=${qid} branch=${executor.branch} worktree=${executor.worktree}`,
      { label: `validator:${qid}:${attempt}`, phase: 'Validate', agentType: 'loom:story-validator', schema: VALIDATOR_SCHEMA }
    )
    if (validate.result !== 'ok') {
      for (const c of validate.criteria.filter(c => !c.pass)) {
        fixes.push({
          title: `fix: ${c.text}`,
          body: `Validation criterion failed.\n\nCriterion: ${c.text}\n\nEvidence: ${c.evidence}`,
        })
      }
    }

    // Converged when neither step produced a fix-item.
    if (fixes.length === 0) {
      return { qid, executor, ok: true, open: [], attempts: attempt }
    }

    // File the collated fix-items so the next dispatch rediscovers them.
    log(`[${qid}] filing ${fixes.length} fix-task(s) and retrying`)
    await fileFixes(qid, fixes)
    open = fixes.map(f => f.title)
  }

  log(`[${qid}] did not converge after ${MAX_ATTEMPTS} attempts`)
  return { qid, executor: null, ok: false, open, attempts: MAX_ATTEMPTS }
}

// ── Convergence ──────────────────────────────────────────────────────────────

log(`Running story ${storyQid} (finalize=${finalize})`)

const result = await prepare(storyQid, 'main')

if (!result.ok) {
  return {
    result: 'failed',
    story_qid: storyQid,
    attempts: result.attempts,
    reason: result.open.join('; '),
  }
}

const { executor } = result
const attempts = result.attempts

// ── Finalize ─────────────────────────────────────────────────────────────────

// Final gate before main (the single-story analog of the epic's epic-validator
// phase): re-validate the branch, mark the story done, then merge or open a PR.
log('Running final story-validator before finalize')
const finalValidation = await agent(
  `story_qid=${storyQid} branch=${executor.branch} worktree=${executor.worktree}`,
  { label: 'final-validator', phase: 'Validate', agentType: 'loom:story-validator', schema: VALIDATOR_SCHEMA }
)
if (finalValidation.result !== 'ok') {
  const unmet = finalValidation.criteria.filter(c => !c.pass).map(c => c.text).join('; ')
  return { result: 'failed', story_qid: storyQid, attempts, reason: `final-validation: ${unmet}` }
}

// Mark the story done in loom.
await agent(
  `Run: loom complete ${storyQid}`,
  { label: `complete-story:${storyQid}`, phase: 'Finalize', agentType: 'loom:story-executor' }
)

if (finalize === 'merge') {
  // Merge + push into main (only when explicitly requested).
  log(`Merging ${executor.branch} into main and pushing`)
  const merge = await agent(
    `Finalize the story by merging the story branch into main and pushing.
Run from the repo root (NOT the story worktree):
1. git checkout main && git fetch origin && git pull --ff-only origin main
2. git merge --no-ff ${executor.branch} -m "Merge ${executor.branch}: story ${storyQid}"

If step 2 conflicts: resolve ONLY trivial, unambiguous conflicts (non-overlapping
added lines, lockfile/index unions, whitespace). If a conflict touches real logic
or there is ANY chance the correct resolution depends on intent, run
"git merge --abort" and return { "merged": false, "conflict": "<files and why>" }
— do NOT push.

On a clean (or trivially-resolved) merge:
3. git push origin main
4. git rev-parse HEAD   (record as merge_sha)
5. git branch -d ${executor.branch}
6. git worktree remove --force ${executor.worktree}
Return { "merged": true, "merge_sha": "<sha>" }.`,
    { label: 'finalize-merge', phase: 'Finalize', schema: MERGE_SCHEMA }
  )
  if (!merge.merged) {
    return { result: 'failed', story_qid: storyQid, attempts, reason: `merge conflict: ${merge.conflict}` }
  }
  log(`Merged ${executor.branch} into main at ${merge.merge_sha}.`)
  return { result: 'ok', story_qid: storyQid, branch: executor.branch, merged_to: 'main', attempts }
} else {
  // Default: push branch + open PR.
  log(`Pushing ${executor.branch} and opening PR`)
  const pr = await agent(
    `Finalize the story by pushing the branch and opening a pull request.
1. cd ${executor.worktree}
2. git push -u origin ${executor.branch}
3. Compose a coherent PR body — do NOT use a generic "automated PR" string. Read
   the story for intent (loom show ${storyQid} --json) and the diff for what shipped:
     git diff main...${executor.branch} --stat
     git log main..${executor.branch} --oneline
   Write a short Markdown body: a one-paragraph summary + a "## Changes" bullet
   list grounded in the diff. Every claim must match a real change.
4. gh pr create --base main --head ${executor.branch} --title "Story ${storyQid}: <short summary>" --body-file <tmpfile> and capture the URL
Return { "pr_url": "<url>" }.`,
    { label: 'finalize-pr', phase: 'Finalize', schema: PR_SCHEMA }
  )
  log(`Finalized. PR URL: ${pr.pr_url ?? '(none)'}`)
  return { result: 'ok', story_qid: storyQid, branch: executor.branch, pr_url: pr.pr_url, attempts }
}
