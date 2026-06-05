// epic-runner.workflow.js — DAG runner for a loom epic.
// Receives: args.epic_qid, args.finalize ('pr' | 'merge', default 'pr').
//
// Phases:
//   Trunk                       — fresh main, create the epic trunk worktree
//   Execute / Validate / Fix    — per-story convergence loop (prepare), streamed
//   Merge                       — serial story-merger into the trunk
//   Epic validation             — epic-validator over the fully-merged trunk
//   Finalize                    — open a PR (default) or merge + push to main

export const meta = {
  name: 'epic-runner',
  description: 'DAG runner for a loom epic: trunk setup → streamed story convergence → epic validation → finalize',
  phases: [
    { title: 'Trunk',           detail: 'Fresh main and the epic trunk worktree' },
    { title: 'Execute',         detail: 'story-executor builds each story branch' },
    { title: 'Validate',        detail: 'story-validator checks criteria and tests' },
    { title: 'Fix',             detail: 'story-fixer applies validator failures inline' },
    { title: 'Merge',           detail: 'story-merger merges each converged story into the trunk' },
    { title: 'Epic validation', detail: 'epic-validator over the fully-merged trunk' },
    { title: 'Finalize',        detail: 'open a PR (default) or merge + push to main' },
  ],
}

// ── Schema constants ─────────────────────────────────────────────────────────
// EXECUTOR_SCHEMA  — story-executor (loom:story-executor) result
// VALIDATOR_SCHEMA — story-validator result
// FIXER_SCHEMA     — story-fixer result
// HYGIENE_SCHEMA   — code-hygiene agent result
// TRUNK_SCHEMA     — trunk-setup agent result
// MERGE_SCHEMA     — merge agent result (story-merger, and finalize-merge)
// READY_SCHEMA     — loom ready query result (scheduler refill)
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

const HYGIENE_SCHEMA = {
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

const READY_SCHEMA = {
  type: 'object',
  required: ['stories'],
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['qualified_id', 'title'],
        properties: {
          qualified_id: { type: 'string' },
          title:        { type: 'string' },
        },
      },
    },
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

// ── Inputs ───────────────────────────────────────────────────────────────────

// args may arrive as an object or as a JSON-encoded string depending on the
// invoking harness; normalize to an object before reading fields.
const input = typeof args === 'string' ? JSON.parse(args) : (args ?? {})

const epicQid = input.epic_qid
if (!epicQid) throw new Error('epic_qid is required')
const finalize = input.finalize ?? 'pr'

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
        { label: `executor:${qid}:${attempt}`, phase: 'Execute', agentType: 'loom:story-executor', schema: EXECUTOR_SCHEMA }
      )
      log(`[${qid}] executor done: branch=${executor.branch}`)
    } else {
      // Fix: story-fixer resumes the existing worktree and applies the failed criteria.
      const failedLines = open.join('\n')
      await agent(
        `story_qid=${qid} branch=${executor.branch} worktree=${executor.worktree}\nfailed_criteria:\n${failedLines}`,
        { label: `fixer:${qid}:${attempt}`, phase: 'Fix', agentType: 'loom:story-fixer', schema: FIXER_SCHEMA }
      )
      log(`[${qid}] fixer done (attempt ${attempt})`)
    }

    // Validate: story-validator checks criteria and tests.
    const validate = await agent(
      `story_qid=${qid} branch=${executor.branch} worktree=${executor.worktree}`,
      { label: `validator:${qid}:${attempt}`, phase: 'Validate', agentType: 'loom:story-validator', schema: VALIDATOR_SCHEMA }
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

log(`Setting up trunk for epic ${epicQid} (finalize=${finalize})`)

// Git forbids colons in ref names, so the epic qid's colons must be
// sanitized for BOTH the branch name and the worktree path (matching the
// story-executor's slug convention of replacing ':' with '-').
const trunkSlug = epicQid.replace(/:/g, '-')
const trunkBranch = `loom/${trunkSlug}`
const trunkWorktree = `.claude/worktrees/${trunkSlug}`

const trunk = await agent(
  `You are setting up the epic trunk worktree for epic_qid="${epicQid}".
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

// ── Story scheduler: streamed prepare() → serial merge ───────────────────────

// refill() queries loom for stories that are ready (deps satisfied, not done).
async function refill() {
  const result = await agent(
    `Run: loom ready ${epicQid} --type story --json
Output the JSON array as the "stories" field.`,
    { label: 'refill', phase: 'Execute', schema: READY_SCHEMA }
  )
  return result.stories ?? []
}

const inflight = new Map()  // qid → Promise<prepare result>
// failed: qid → string[] (open findings). A failed story is NOT halted on; we
// record it and keep draining the rest of the DAG. Its dependents never become
// ready (they depend on a not-done story), so the subtree naturally stops. We
// skip relaunching anything already failed.
const failed = new Map()

let stories = await refill()

while (stories.length > 0 || inflight.size > 0) {
  // Launch prepare() for every newly-ready story not already in flight or failed.
  for (const s of stories) {
    if (!inflight.has(s.qualified_id) && !failed.has(s.qualified_id)) {
      log(`Launching prepare for ${s.qualified_id}: ${s.title}`)
      inflight.set(s.qualified_id, prepare(s.qualified_id, trunk.branch))
    }
  }

  if (inflight.size === 0) break

  // Wait for whichever prepare() finishes next.
  const result = await Promise.race(inflight.values())
  inflight.delete(result.qid)

  if (!result.ok) {
    // Did not converge. Record it and keep going — other inflight stories
    // continue, and refill keeps the independent parts of the DAG moving.
    failed.set(result.qid, result.open)
    log(`Story ${result.qid} did not converge; continuing with the rest of the DAG.`)
    stories = await refill()
    continue
  }

  // Converged — merge + complete + cleanup via the story-merger agent.
  log(`Merging ${result.qid} (branch: ${result.executor.branch}) into trunk`)
  const merge = await agent(
    `story_qid=${result.qid} branch=${result.executor.branch} target=${trunk.branch} ` +
    `target_worktree=${trunk.worktree} story_worktree=${result.executor.worktree}`,
    { label: `merge:${result.qid}`, phase: 'Merge', agentType: 'loom:story-merger', schema: MERGE_SCHEMA }
  )

  if (!merge.merged) {
    // Non-trivial conflict — record and keep going rather than halting.
    failed.set(result.qid, [`merge conflict: ${merge.conflict}`])
    log(`Story ${result.qid} could not be merged trivially; continuing with the rest of the DAG.`)
    stories = await refill()
    continue
  }

  log(`Merged ${result.qid} at ${merge.merge_sha}.`)
  stories = await refill()
}

if (failed.size > 0) {
  const summary = [...failed.entries()]
    .map(([q, fs]) => `${q}: ${fs.join(', ')}`)
    .join('\n')
  return {
    result: 'failed',
    reason: `${failed.size} story/stories did not converge or merge; the rest of the DAG was drained.`,
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
  { label: 'code-hygiene', phase: 'Epic validation', agentType: 'loom:code-hygiene', schema: HYGIENE_SCHEMA }
)

// ── Epic validation ──────────────────────────────────────────────────────────

log(`Dispatching epic-validator for ${epicQid}`)

const epicVal = await agent(
  `epic_qid=${epicQid} branch=${trunk.branch} worktree=${trunk.worktree}`,
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
  `Run: loom complete ${epicQid}`,
  { label: `complete-epic:${epicQid}`, phase: 'Epic validation', agentType: 'loom:story-executor' }
)

// ── Finalize ─────────────────────────────────────────────────────────────────

if (finalize === 'merge') {
  // Local merge + push into main (only when explicitly requested).
  log(`Merging ${trunk.branch} into main and pushing`)
  const merge = await agent(
    `Finalize the epic by merging the trunk branch into main and pushing.
Run from the repo root (NOT the trunk worktree):
1. git checkout main && git fetch origin && git pull --ff-only origin main
2. git merge --no-ff ${trunk.branch} -m "Merge epic ${epicQid}: ${trunk.branch}"

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
  return { result: 'ok', epic_qid: epicQid, branch: trunk.branch, merged_to: 'main' }
} else {
  // Default: push branch + open PR.
  log(`Pushing ${trunk.branch} and opening PR`)
  const pr = await agent(
    `Finalize the epic by pushing the branch and opening a pull request.
1. cd ${trunk.worktree}
2. git push -u origin ${trunk.branch}
3. Compose a coherent PR body — do NOT just paste the epic body. Read the epic for
   intent (loom show ${epicQid} --json) and the diff for what shipped:
     git diff main...${trunk.branch} --stat
     git log main..${trunk.branch} --oneline
   Write a short Markdown body: a one-paragraph summary + a "## Changes" bullet
   list grounded in the diff. Every claim must match a real change.
4. gh pr create --base main --head ${trunk.branch} --title "Epic ${epicQid}: <short summary>" --body-file <tmpfile> and capture the URL
Return { "pr_url": "<url>" }.`,
    { label: 'finalize-pr', phase: 'Finalize', schema: PR_SCHEMA }
  )
  log(`Finalized. PR URL: ${pr.pr_url ?? '(none)'}`)
  return { result: 'ok', epic_qid: epicQid, branch: trunk.branch, pr_url: pr.pr_url }
}
