// epic-runner.template.js — template for the epic-runner workflow.
// NOTE: This file is NOT directly runnable. The placeholder tokens
// (__EPIC_QID__, __FINALIZE__, __STORIES_JSON__) must be filled before
// execution. For `node --check` syntax validation, replace __STORIES_JSON__
// with [] (the __X__ string tokens are already valid JS string literals).
//
// Originally derived from: plugin/workflows/epic-runner.workflow.js
// Receives: EPIC_QID and FINALIZE are baked-in by the instantiation step;
//   STORIES is the pre-computed baked-DAG list.

export const meta = {
  name: 'epic-runner',
  description: 'DAG runner for a loom epic: trunk setup → streamed story convergence → epic validation → finalize',
  phases: [
    { title: 'Trunk',           detail: 'Fresh main and the epic trunk worktree' },
    { title: 'Stories',         detail: 'Per story: build → validate → fix → merge into the trunk (independent stories run concurrently)' },
    { title: 'Epic validation', detail: 'epic-validator over the fully-merged trunk' },
    { title: 'Finalize',        detail: 'open a PR (default) or merge + push to main' },
  ],
}

// ── Schema constants ─────────────────────────────────────────────────────────
// EXECUTOR_SCHEMA  — story-executor (loom:story-executor) result
// VALIDATOR_SCHEMA — story-validator result
// FIXER_SCHEMA     — story-fixer and code-hygiene agent result
// TRUNK_SCHEMA     — trunk-setup agent result
// MERGE_SCHEMA     — merge agent result (story-merger, and finalize-merge)
// EPIC_VAL_SCHEMA  — loom:epic-validator result
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

const FIXER_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
  },
}

const TRUNK_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok:       { type: 'boolean' },
    error:    { type: ['string', 'null'] },
    worktree: { type: ['string', 'null'] },
    branch:   { type: ['string', 'null'] },
    main_sha: { type: ['string', 'null'] },
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

const EPIC_VAL_SCHEMA = {
  type: 'object',
  required: ['result'],
  properties: {
    result:   { type: 'string', enum: ['ok', 'failed'] },
    criteria: { type: 'array' },
    notes:    { type: 'string' },
  },
}

const PR_SCHEMA = {
  type: 'object',
  required: ['pr_url'],
  properties: { pr_url: { type: ['string', 'null'] } },
}

// ── Baked-in inputs (filled by instantiation) ─────────────────────────────────

const EPIC_QID = '__EPIC_QID__'
const FINALIZE = '__FINALIZE__'
// STORIES: array of { qid, title, deps } objects. `deps` is an array of qids
// that must be merged before this story launches. Order within the array does
// not matter — the scheduler instantiates every story up front and resolves
// dependencies by qid, so STORIES need not be topologically sorted.
const STORIES = __STORIES_JSON__

// ── Helpers ──────────────────────────────────────────────────────────────────

// prepare(qid, parentBranch) — execute → validate convergence loop (≤3 attempts).
// Attempt 1: story-executor builds the branch. Subsequent attempts: story-fixer
// applies the failed criteria from the previous validate step. Steps are tagged
// via opts.phase (NOT phase()) so the loop is safe to run concurrently.
// Returns { qid, executor, ok, open, attempts }:
//   ok:       true if the story converged
//   executor: the executor result (kept from attempt 1)
//   open:     array of unmet criterion texts (non-empty only when ok=false)
//   attempts: number of attempts made
async function prepare(qid, parentBranch) {
  const MAX_ATTEMPTS = 3
  let attempt = 0
  let executor = null
  let open = []

  while (attempt < MAX_ATTEMPTS) {
    attempt++
    log(`[${qid}] prepare attempt ${attempt}/${MAX_ATTEMPTS}`)

    if (attempt === 1) {
      // Execute: story-executor builds the story branch.
      executor = await agent(
        `story_qid=${qid} parent_branch=${parentBranch}`,
        { label: `executor:${qid}:${attempt}`, phase: 'Stories', agentType: 'loom:story-executor', schema: EXECUTOR_SCHEMA }
      )
      log(`[${qid}] executor done: branch=${executor.branch}`)
    } else {
      // Fix: story-fixer resumes the existing worktree and applies the failed criteria.
      const failedLines = open.join('\n')
      await agent(
        `story_qid=${qid} branch=${executor.branch} worktree=${executor.worktree}\nfailed_criteria:\n${failedLines}`,
        { label: `fixer:${qid}:${attempt}`, phase: 'Stories', agentType: 'loom:story-fixer', schema: FIXER_SCHEMA }
      )
      log(`[${qid}] fixer done (attempt ${attempt})`)
    }

    // Validate: story-validator checks criteria and tests.
    const validate = await agent(
      `story_qid=${qid} branch=${executor.branch} worktree=${executor.worktree}`,
      { label: `validator:${qid}:${attempt}`, phase: 'Stories', agentType: 'loom:story-validator', schema: VALIDATOR_SCHEMA }
    )

    if (validate.result === 'ok') {
      return { qid, executor, ok: true, open: [], attempts: attempt }
    }

    open = validate.criteria.filter(c => !c.pass).map(c => c.text)
    log(`[${qid}] validation failed: ${open.length} unmet criterion(a)`)
  }

  log(`[${qid}] did not converge after ${MAX_ATTEMPTS} attempts`)
  return { qid, executor, ok: false, open, attempts: MAX_ATTEMPTS }
}

// ── Trunk setup ──────────────────────────────────────────────────────────────

log(`Setting up trunk for epic ${EPIC_QID} (finalize=${FINALIZE})`)

// Git forbids colons in ref names, so the epic qid's colons must be
// sanitized for BOTH the branch name and the worktree path (matching the
// story-executor's slug convention of replacing ':' with '-').
const trunkSlug = EPIC_QID.replace(/:/g, '-')
const trunkBranch = `loom/${trunkSlug}`
const trunkWorktree = `.claude/worktrees/${trunkSlug}`

const trunk = await agent(
  `You are setting up the epic trunk worktree for epic_qid="${EPIC_QID}".
The target branch is "${trunkBranch}" and the target worktree path is
"${trunkWorktree}".

Steps:
1. Ensure main is up to date:
   git checkout main && git fetch origin && git pull --ff-only origin main
   If git pull --ff-only fails, STOP and return the failure result below.
2. Record main_sha BEFORE creating the worktree: git rev-parse HEAD
3. Reconcile any existing state, then create or reuse the trunk worktree.
   First inspect what already exists:
     git worktree list --porcelain
     git branch --list ${trunkBranch}
   Then pick the matching case:
   a. Neither the worktree path nor the branch exists (fresh):
        git worktree add -b ${trunkBranch} ${trunkWorktree} main
   b. The branch exists but NO worktree is checked out on it:
        git worktree add ${trunkWorktree} ${trunkBranch}
   c. A worktree is ALREADY registered at ${trunkWorktree} on branch
      ${trunkBranch} (re-run of a partially-completed epic): reuse it in
      place — do NOT run 'git worktree add'. Just cd into it and verify.
   d. ${trunkWorktree} exists on disk but is NOT a registered worktree
      (stale leftover): run 'git worktree prune', remove the stale dir if
      still present (rm -rf ${trunkWorktree}), then go to case (a) or (b).
4. Confirm the worktree at ${trunkWorktree} is checked out on branch
   ${trunkBranch} (git -C ${trunkWorktree} rev-parse --abbrev-ref HEAD).

On success, return { "ok": true, "worktree": "${trunkWorktree}",
"branch": "${trunkBranch}", "main_sha": "<sha>" }.

If ANY step fails — the fast-forward pull fails, a 'git worktree add'
command errors, the branch ref is rejected, or the final checkout is not
on ${trunkBranch} — do NOT improvise or stuff an error message into
another field. Return { "ok": false, "error": "<concise reason>",
"worktree": null, "branch": null, "main_sha": null } and stop.`,
  { label: 'trunk-setup', phase: 'Trunk', schema: TRUNK_SCHEMA }
)

if (!trunk.ok || !trunk.worktree || !trunk.branch) {
  log(`Trunk setup FAILED — halting epic. ${trunk.error ?? '(no worktree created)'}`)
  return {
    result: 'failed',
    reason: `trunk setup failed: ${trunk.error ?? 'no worktree created'}`,
  }
}

log(`Trunk worktree: ${trunk.worktree} on branch ${trunk.branch}`)

// ── Story scheduler: baked-DAG promise pipeline → serial merge ───────────────
//
// Every story is INSTANTIATED up front as a pending (not-done) promise in
// `runs` — before any run-body executes. A run waits on its dependencies by
// awaiting their promises from this fully-populated store, so a dependency
// lookup always finds something to await regardless of the order of STORIES.
// There is NO requirement that STORIES be topologically sorted: a story stays
// "not done" until its own run settles it, and nothing it depends on can be
// observed as `ok` before then. agent() caps real concurrency internally, so
// starting every run at once still respects the worker pool.
//
// Each run then (1) awaits its dependencies' outcomes, (2) runs prepare() —
// concurrently with every independent sibling — then (3) serializes its merge
// into the single shared trunk worktree.
//
// outcome: qid → { ok, open? } (the central store). A non-ok story is NOT
// halted on; its dependents observe the failure via the store and skip
// themselves, so the dependent subtree drains naturally while independent
// branches keep going.
const outcome = new Map()   // qid → { ok: boolean, open?: string[] }
const runs = new Map()      // qid → Promise<outcome>  (pending until the story settles)
const settle = new Map()    // qid → resolve fn for that story's run promise

// Instantiate every story as pending up front. Nothing is "done", so no
// dependent can proceed until the story it waits on is actually resolved below.
for (const s of STORIES) {
  runs.set(s.qid, new Promise(resolve => settle.set(s.qid, resolve)))
}

// Merge gate: a chained promise that serializes story-merger calls. prepare()
// runs in parallel across stories, but every merge writes the one trunk
// worktree — they must run strictly one at a time. Each queued merge waits for
// the previous to settle (the gate is kept alive past failures).
let mergeGate = Promise.resolve()
function runSerialMerge(fn) {
  const ran = mergeGate.then(fn, fn)
  mergeGate = ran.then(() => {}, () => {})
  return ran
}

async function runStory(s) {
  const deps = s.deps ?? []

  // 1. Wait for every dependency to finish; bail if any did not land.
  const depOutcomes = await Promise.all(deps.map(d => runs.get(d)))
  const blockerIdx = depOutcomes.findIndex(o => !o.ok)
  if (blockerIdx !== -1) {
    const blocker = deps[blockerIdx]
    log(`Skipping ${s.qid}: upstream ${blocker} did not converge/merge.`)
    return { ok: false, open: [`skipped: upstream ${blocker} did not land`] }
  }

  // 2. Build the story branch (concurrent with independent siblings).
  log(`Launching prepare for ${s.qid}: ${s.title}`)
  const result = await prepare(s.qid, trunk.branch)
  if (!result.ok) {
    log(`Story ${s.qid} did not converge; its dependents will skip.`)
    return { ok: false, open: result.open }
  }

  // 3. Merge serially into the trunk.
  log(`Merging ${s.qid} (branch: ${result.executor.branch}) into trunk`)
  const merge = await runSerialMerge(() => agent(
    `story_qid=${s.qid} branch=${result.executor.branch} target=${trunk.branch} ` +
    `target_worktree=${trunk.worktree} story_worktree=${result.executor.worktree}`,
    { label: `merge:${s.qid}`, phase: 'Stories', agentType: 'loom:story-merger', schema: MERGE_SCHEMA }
  ))
  if (!merge.merged) {
    log(`Story ${s.qid} could not be merged trivially; its dependents will skip.`)
    return { ok: false, open: [`merge conflict: ${merge.conflict}`] }
  }

  log(`Merged ${s.qid} at ${merge.merge_sha}.`)
  return { ok: true }
}

// Start every story's run against the fully-instantiated store. Record each
// outcome and resolve its pending promise so dependents can proceed. The error
// handler guarantees the promise always settles (an unexpected throw becomes a
// recorded failure) so a sibling's bug can never deadlock the whole DAG.
for (const s of STORIES) {
  runStory(s).then(
    o => { outcome.set(s.qid, o); settle.get(s.qid)(o) },
    err => {
      const o = { ok: false, open: [`run error: ${err?.message ?? String(err)}`] }
      outcome.set(s.qid, o)
      settle.get(s.qid)(o)
    }
  )
}
await Promise.all(runs.values())

const failures = STORIES.filter(s => !(outcome.get(s.qid)?.ok))
if (failures.length > 0) {
  const summary = failures
    .map(s => `${s.qid}: ${(outcome.get(s.qid)?.open ?? []).join(', ')}`)
    .join('\n')
  return {
    result: 'failed',
    reason: `${failures.length} story/stories did not converge or merge; the rest of the DAG was drained.`,
    open_findings: summary,
  }
}

log('All stories merged into trunk.')

// ── Hygiene pass ─────────────────────────────────────────────────────────────

// Run code-hygiene over the merged trunk branch before epic validation.
// Hygiene edits land on the trunk and are then gated by epic-validator.
log(`Running code-hygiene pass over trunk before epic validation`)
await agent(
  `branch=${trunk.branch} worktree=${trunk.worktree} trunk=main`,
  { label: 'code-hygiene', phase: 'Epic validation', agentType: 'loom:code-hygiene', schema: FIXER_SCHEMA }
)

// ── Epic validation ──────────────────────────────────────────────────────────

log(`Dispatching epic-validator for ${EPIC_QID}`)

const epicVal = await agent(
  `epic_qid=${EPIC_QID} branch=${trunk.branch} worktree=${trunk.worktree}`,
  { label: 'epic-validator', phase: 'Epic validation', agentType: 'loom:epic-validator', schema: EPIC_VAL_SCHEMA }
)

if (epicVal.result !== 'ok') {
  log(`Epic validation FAILED. Notes: ${epicVal.notes ?? '(none)'}`)
  return {
    result: 'failed',
    reason: 'epic-validator returned failed',
    criteria: epicVal.criteria,
    notes: epicVal.notes,
  }
}

log('Epic validation passed.')

// Mark the epic done in loom.
await agent(
  `Run: loom complete ${EPIC_QID}`,
  { label: `complete-epic:${EPIC_QID}`, phase: 'Epic validation', agentType: 'loom:story-executor' }
)

// ── Finalize ─────────────────────────────────────────────────────────────────

if (FINALIZE === 'merge') {
  // Local merge + push into main (only when explicitly requested).
  log(`Merging ${trunk.branch} into main and pushing`)
  const merge = await agent(
    `Finalize the epic by merging the trunk branch into main and pushing.
Run from the repo root (NOT the trunk worktree):
1. git checkout main && git fetch origin && git pull --ff-only origin main
2. git merge --no-ff ${trunk.branch} -m "Merge epic ${EPIC_QID}: ${trunk.branch}"

If step 2 conflicts: resolve ONLY trivial, unambiguous conflicts (non-overlapping
added lines, lockfile/index unions, whitespace). If a conflict touches real logic
or there is ANY chance the correct resolution depends on intent, run
"git merge --abort" and return { "merged": false, "conflict": "<files and why>" }
— do NOT push.

On a clean (or trivially-resolved) merge:
3. git push origin main
4. git rev-parse HEAD   (record as merge_sha)
5. git branch -d ${trunk.branch}
6. git worktree remove --force ${trunk.worktree}
Return { "merged": true, "merge_sha": "<sha>" }.`,
    { label: 'finalize-merge', phase: 'Finalize', schema: MERGE_SCHEMA }
  )
  if (!merge.merged) {
    return { result: 'failed', reason: `merge conflict: ${merge.conflict}` }
  }
  log(`Merged ${trunk.branch} into main at ${merge.merge_sha}.`)
  return { result: 'ok', epic_qid: EPIC_QID, branch: trunk.branch, merged_to: 'main' }
} else {
  // Default: push branch + open PR.
  log(`Pushing ${trunk.branch} and opening PR`)
  const pr = await agent(
    `Finalize the epic by pushing the branch and opening a pull request.
1. cd ${trunk.worktree}
2. git push -u origin ${trunk.branch}
3. Compose a coherent PR body — do NOT just paste the epic body. Read the epic for
   intent (loom show ${EPIC_QID} --json) and the diff for what shipped:
     git diff main...${trunk.branch} --stat
     git log main..${trunk.branch} --oneline
   Write a short Markdown body: a one-paragraph summary + a "## Changes" bullet
   list grounded in the diff. Every claim must match a real change.
4. gh pr create --base main --head ${trunk.branch} --title "Epic ${EPIC_QID}: <short summary>" --body-file <tmpfile> and capture the URL
Return { "pr_url": "<url>" }.`,
    { label: 'finalize-pr', phase: 'Finalize', schema: PR_SCHEMA }
  )
  log(`Finalized. PR URL: ${pr.pr_url ?? '(none)'}`)
  return { result: 'ok', epic_qid: EPIC_QID, branch: trunk.branch, pr_url: pr.pr_url }
}
