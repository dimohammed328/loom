// epic.workflow.js — DAG runner for a loom epic.
// Receives: args.epic_qid, args.project (optional), args.finalize ('pr'|'merge', default 'pr')
//
// Phases:
//   Trunk   — checkout fresh main, create epic trunk worktree
//   Stories — streaming scheduler: prepare() → serial merge, up to 3 retries per story
//   Validate — dispatch epic-validator
//   Finalize — push + PR (default) or local merge+push

export const meta = {
  name: 'epic',
  description: 'DAG runner for a loom epic: trunk setup → story scheduler → epic validation → finalize',
  phases: [
    { title: 'Trunk',    detail: 'Checkout fresh main and create the epic trunk worktree' },
    { title: 'Stories',  detail: 'Streaming scheduler — prepare each story then serial merge' },
    { title: 'Validate', detail: 'Run epic-validator against the fully-merged trunk' },
    { title: 'Finalize', detail: 'Push + open PR (default) or local merge+push to main' },
  ],
}

// ── Schema constants ─────────────────────────────────────────────────────────
// TRUNK_SCHEMA  — trunk-setup agent result
// BUILD_SCHEMA  — story-executor (loom:story-executor) result
// REVIEW_SCHEMA — code-reviewer result
// VALIDATE_SCHEMA — story-validator result
// MERGE_SCHEMA  — story-merger agent result (merge + complete + cleanup)
// READY_SCHEMA  — loom ready query result (wave / refill)
// EPIC_VAL_SCHEMA — loom:epic-validator result
// FIN_SCHEMA    — finalize agent result (PR URL or merge note)

const TRUNK_SCHEMA = {
  type: 'object',
  required: ['worktree', 'branch', 'main_sha'],
  properties: {
    worktree:  { type: 'string' },
    branch:    { type: 'string' },
    main_sha:  { type: 'string' },
  },
}

const BUILD_SCHEMA = {
  type: 'object',
  required: ['story_qid', 'branch', 'worktree', 'commits'],
  properties: {
    story_qid:  { type: 'string' },
    branch:     { type: 'string' },
    worktree:   { type: 'string' },
    commits:    { type: 'array', items: { type: 'string' } },
    notes:      { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
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

const VALIDATE_SCHEMA = {
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
  required: ['merged', 'merge_sha'],
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

const FIN_SCHEMA = {
  type: 'object',
  required: ['pr_url'],
  properties: {
    pr_url: { type: ['string', 'null'] },
    note:   { type: 'string' },
  },
}

// ── Phase 1: Trunk setup ──────────────────────────────────────────────────────

phase('Trunk')

const epicQid    = args.epic_qid
const finalize   = args.finalize ?? 'pr'
const trunkBranch = `loom/${epicQid}`

log(`Setting up trunk for epic ${epicQid} (finalize=${finalize})`)

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
  { label: 'trunk-setup', schema: TRUNK_SCHEMA }
)

log(`Trunk worktree: ${trunk.worktree} on branch ${trunk.branch}`)

// ── prepare(s): build → review → validate, up to 3 attempts ─────────────────
// Returns { qid, build, ok, open }
//   ok:   true if the story converged
//   open: array of unmet-criterion strings (non-empty only when ok=false)

async function prepare(s) {
  const MAX_ATTEMPTS = 3
  let attempt = 0
  let open = []

  while (attempt < MAX_ATTEMPTS) {
    attempt++
    log(`[${s.qualified_id}] prepare attempt ${attempt}/${MAX_ATTEMPTS}`)

    // ── Step A: story-executor (build) ───────────────────────────────────────
    const build = await agent(
      `story_qid=${s.qualified_id} parent_branch=${trunk.branch}`,
      { label: `executor:${s.qualified_id}:${attempt}`, agentType: 'loom:story-executor', schema: BUILD_SCHEMA }
    )

    // Collect fix-items from BOTH the review and validate steps as local
    // objects, then file them all in a single agent at the end of the
    // iteration — one batched `loom task create` pass, not one agent per item.
    const fixes = []  // [{ title, body }]

    // ── Step B: code-reviewer ────────────────────────────────────────────────
    const review = await agent(
      `story_qid=${s.qualified_id} branch=${build.branch} trunk=${trunk.branch} worktree=${build.worktree}`,
      { label: `reviewer:${s.qualified_id}:${attempt}`, agentType: 'code-reviewer', schema: REVIEW_SCHEMA }
    )
    if (!review.clean) {
      for (const f of review.findings) {
        fixes.push({
          title: `fix: ${f.title}`,
          body: `${f.detail}\n\nLocation: ${f.file}:${f.lines}`,
        })
      }
    }

    // ── Step C: story-validator ──────────────────────────────────────────────
    const validate = await agent(
      `story_qid=${s.qualified_id} branch=${build.branch} worktree=${build.worktree}`,
      { label: `validator:${s.qualified_id}:${attempt}`, agentType: 'story-validator', schema: VALIDATE_SCHEMA }
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
      return { qid: s.qualified_id, build, ok: true, open: [] }
    }

    // ── Step D: file all fix-items as loom tasks via ONE agent ───────────────
    log(`[${s.qualified_id}] filing ${fixes.length} fix-task(s) and retrying`)
    const createCmds = fixes
      .map(f => `loom -y task create --title ${JSON.stringify(f.title)} --body ${JSON.stringify(f.body)} ${s.qualified_id}`)
      .join('\n')
    await agent(
      `Run each of these commands in order; confirm each exits 0:\n${createCmds}`,
      { label: `file-tasks:${s.qualified_id}:${attempt}`, agentType: 'loom:story-executor' }
    )
    open = fixes.map(f => f.title)
  }

  // Exhausted retries
  log(`[${s.qualified_id}] did not converge after ${MAX_ATTEMPTS} attempts`)
  return { qid: s.qualified_id, build: null, ok: false, open }
}

// ── Phase 2: Streaming scheduler + serial merge ───────────────────────────────

phase('Stories')

// refill() queries loom for stories that are ready (deps satisfied, not done)
async function refill() {
  const result = await agent(
    `Run: loom ready ${epicQid} --type story --json
Output the JSON array as the "stories" field.`,
    { label: 'refill', schema: READY_SCHEMA }
  )
  return result.stories ?? []
}

// inflight: Map<qid, Promise<{qid, build, ok, open}>>
const inflight = new Map()
// failed: Map<qid, string[]> — stories that did not converge or could not merge.
// A failed story is NOT halted on; we record it and keep draining the rest of
// the DAG. Its dependents never become ready (they depend on a not-done story),
// so the subtree naturally stops. We skip relaunching anything already failed.
const failed = new Map()

let stories = await refill()

while (stories.length > 0 || inflight.size > 0) {
  // Launch prepare() for every new ready story not already in flight or failed
  for (const s of stories) {
    if (!inflight.has(s.qualified_id) && !failed.has(s.qualified_id)) {
      log(`Launching prepare for ${s.qualified_id}: ${s.title}`)
      inflight.set(s.qualified_id, prepare(s))
    }
  }

  if (inflight.size === 0) break

  // Wait for whichever prepare() finishes next
  const result = await Promise.race(inflight.values())
  inflight.delete(result.qid)

  if (!result.ok) {
    // Story did not converge. Record it and keep going — other inflight stories
    // continue, and refill keeps the independent parts of the DAG moving.
    failed.set(result.qid, result.open)
    log(`Story ${result.qid} did not converge; continuing with the rest of the DAG.`)
    stories = await refill()
    continue
  }

  // Story converged — merge + complete + cleanup via the story-merger agent.
  log(`Merging ${result.qid} (branch: ${result.build.branch}) into trunk`)
  const merge = await agent(
    `story_qid=${result.qid} branch=${result.build.branch} target=${trunk.branch} ` +
    `target_worktree=${trunk.worktree} story_worktree=${result.build.worktree}`,
    { label: `merge:${result.qid}`, agentType: 'story-merger', schema: MERGE_SCHEMA }
  )

  if (!merge.merged) {
    // Non-trivial conflict — record and keep going rather than halting.
    failed.set(result.qid, [`merge conflict: ${merge.conflict}`])
    log(`Story ${result.qid} could not be merged trivially; continuing with the rest of the DAG.`)
    stories = await refill()
    continue
  }

  log(`Merged ${result.qid} at ${merge.merge_sha}.`)

  // Refill with any newly-unblocked stories
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

// ── Phase 3: Epic validation ──────────────────────────────────────────────────

phase('Validate')

log(`Dispatching epic-validator for ${epicQid}`)

const epicVal = await agent(
  `epic_qid=${epicQid} branch=${trunk.branch} worktree=${trunk.worktree}`,
  { label: 'epic-validator', agentType: 'loom:epic-validator', schema: EPIC_VAL_SCHEMA }
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

// Mark the epic done in loom
await agent(
  `Run: loom complete ${epicQid}`,
  { label: `complete-epic:${epicQid}`, agentType: 'loom:story-executor' }
)

// ── Phase 4: Finalize ─────────────────────────────────────────────────────────

phase('Finalize')

let fin

if (finalize === 'merge') {
  // Local merge + push into main (only when explicitly requested)
  log(`Merging ${trunk.branch} into main and pushing`)
  fin = await agent(
    `Finalize the epic by merging the trunk branch into main and pushing.
Steps:
1. cd to the repo root (not the trunk worktree).
2. git checkout main && git pull --ff-only origin main
3. git merge --no-ff ${trunk.branch} -m "Merge epic ${epicQid}: ${trunk.branch}"
4. git push origin main
5. git branch -d ${trunk.branch}
6. git worktree remove --force ${trunk.worktree}
Return pr_url=null and a note confirming the push.`,
    { label: 'finalize-merge', schema: FIN_SCHEMA }
  )
} else {
  // Default: push branch + open PR
  log(`Pushing ${trunk.branch} and opening PR`)
  fin = await agent(
    `Finalize the epic by pushing the branch and opening a pull request.

Steps:
1. cd ${trunk.worktree}
2. git push -u origin ${trunk.branch}
3. Compose a coherent PR body. Do NOT just paste the epic body. Read the epic
   for intent (loom show ${epicQid} --json), then read the actual diff to
   describe what really shipped:
     git diff main...${trunk.branch} --stat
     git log main..${trunk.branch} --oneline
   Write a Markdown body with: a one-paragraph summary of what this epic
   delivers, a "## Changes" bullet list grounded in the diff/commits, and a
   "## Validation" note on how it was verified. Keep it tight and accurate to
   the diff — every claim must be supported by a change you actually see.
4. Open the PR with your composed body (use a heredoc / --body-file to avoid
   shell-quoting issues):
     gh pr create --base main --head ${trunk.branch} --title "Epic ${epicQid}: <short summary>" --body-file <tmpfile>
5. Return the PR URL as pr_url.`,
    { label: 'finalize-pr', schema: FIN_SCHEMA }
  )
}

log(`Finalized. PR URL: ${fin.pr_url ?? 'n/a (merged directly)'}`)

return {
  result: 'ok',
  epic_qid: epicQid,
  branch: trunk.branch,
  pr_url: fin.pr_url,
}
