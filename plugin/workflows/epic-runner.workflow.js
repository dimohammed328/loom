// epic-runner.workflow.js — DAG runner for a loom epic.
// Receives: args.epic_qid, args.finalize ('pr' | 'merge', default 'pr').
//
// Phases:
//   Trunk                    — fresh main, create the epic trunk worktree
//   Execute / Review / Validate — per-story convergence loop (prepare), streamed
//   Merge                    — serial story-merger into the trunk
//   Epic validation          — epic-validator over the fully-merged trunk
//   Finalize                 — open a PR (default) or merge + push to main

export const meta = {
  name: 'epic-runner',
  description: 'DAG runner for a loom epic: trunk setup → streamed story convergence → epic validation → finalize',
  phases: [
    { title: 'Trunk',           detail: 'Fresh main and the epic trunk worktree' },
    { title: 'Execute',         detail: 'story-executor builds each story branch' },
    { title: 'Review',          detail: 'code-reviewer checks hygiene' },
    { title: 'Validate',        detail: 'story-validator checks criteria and tests' },
    { title: 'Merge',           detail: 'story-merger merges each converged story into the trunk' },
    { title: 'Epic validation', detail: 'epic-validator over the fully-merged trunk' },
    { title: 'Finalize',        detail: 'open a PR (default) or merge + push to main' },
  ],
}

// ── Schema constants ─────────────────────────────────────────────────────────
// EXECUTOR_SCHEMA  — story-executor (loom:story-executor) result
// REVIEWER_SCHEMA  — code-reviewer result
// VALIDATOR_SCHEMA — story-validator result
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

const TRUNK_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'main_sha'],
  properties: {
    worktree: { type: 'string' },
    branch:   { type: 'string' },
    main_sha: { type: 'string' },
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

// ── Trunk setup ──────────────────────────────────────────────────────────────

log(`Setting up trunk for epic ${epicQid} (finalize=${finalize})`)

const trunkBranch = `loom/${epicQid}`
const trunkWorktree = `.claude/worktrees/${epicQid.replace(/:/g, '-')}`

const trunk = await agent(
  `You are setting up the epic trunk worktree for epic_qid="${epicQid}".
The target branch is "${trunkBranch}" and the target worktree path is
"${trunkWorktree}".

Steps:
1. Ensure main is up to date:
   git checkout main && git fetch origin && git pull --ff-only origin main
   If git pull --ff-only fails, HALT — do not proceed.
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
Return the worktree path, branch name, and main_sha.`,
  { label: 'trunk-setup', phase: 'Trunk', schema: TRUNK_SCHEMA }
)

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
