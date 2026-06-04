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

// ── Schema constants ──────────────────────────────────────────────────────────

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
  required: ['story_qid', 'branch', 'worktree', 'commits', 'tasks_done'],
  properties: {
    story_qid:  { type: 'string' },
    branch:     { type: 'string' },
    worktree:   { type: 'string' },
    commits:    { type: 'array', items: { type: 'string' } },
    tasks_done: { type: 'array', items: { type: 'string' } },
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
        required: ['title', 'detail', 'severity'],
        properties: {
          title:    { type: 'string' },
          detail:   { type: 'string' },
          severity: { type: 'string', enum: ['error', 'warning', 'suggestion'] },
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

const trunk = await agent(
  `You are setting up the epic trunk worktree for epic_qid="${epicQid}".

Steps:
1. Ensure main is up to date:
   git checkout main && git fetch origin && git pull --ff-only origin main
   If git pull --ff-only fails, HALT — do not proceed.
2. Create the epic trunk branch and worktree:
   git worktree add -b ${trunkBranch} .claude/worktrees/${epicQid.replace(/:/g, '-')} main
   (If the branch already exists, use: git worktree add .claude/worktrees/${epicQid.replace(/:/g, '-')} ${trunkBranch})
3. Confirm the worktree is on branch ${trunkBranch}.
4. Run: git rev-parse HEAD  (on main, before the worktree add) and record as main_sha.
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

    // ── Step B: code-reviewer ────────────────────────────────────────────────
    const review = await agent(
      `story_qid=${s.qualified_id} branch=${build.branch} trunk=${trunk.branch} worktree=${build.worktree}`,
      { label: `reviewer:${s.qualified_id}:${attempt}`, agentType: 'code-reviewer', schema: REVIEW_SCHEMA }
    )

    if (!review.clean) {
      const errors = review.findings.filter(f => f.severity === 'error')
      log(`[${s.qualified_id}] code-reviewer found ${errors.length} error(s)`)
      if (errors.length > 0) {
        // File error findings as loom tasks and retry
        for (const f of errors) {
          await agent(
            `Run: loom -y task create --title ${JSON.stringify('fix: ' + f.title)} ` +
            `--body ${JSON.stringify(f.detail)} ${s.qualified_id}`,
            { label: `file-task:${s.qualified_id}`, agentType: 'loom:story-executor' }
          )
        }
        open = errors.map(f => f.title)
        continue  // retry
      }
    }

    // ── Step C: story-validator ──────────────────────────────────────────────
    const validate = await agent(
      `story_qid=${s.qualified_id} branch=${build.branch} worktree=${build.worktree}`,
      { label: `validator:${s.qualified_id}:${attempt}`, agentType: 'story-validator', schema: VALIDATE_SCHEMA }
    )

    if (validate.result === 'ok') {
      return { qid: s.qualified_id, build, ok: true, open: [] }
    }

    // Validation failed — file unmet criteria as fix tasks and retry
    const failed = validate.criteria.filter(c => !c.pass)
    log(`[${s.qualified_id}] validator failed: ${failed.length} unmet criteria`)
    for (const c of failed) {
      await agent(
        `Run: loom -y task create --title ${JSON.stringify('fix: ' + c.text)} ` +
        `--body ${JSON.stringify('Evidence: ' + c.evidence)} ${s.qualified_id}`,
        { label: `file-task:${s.qualified_id}`, agentType: 'loom:story-executor' }
      )
    }
    open = failed.map(c => c.text)
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
// openFindings: Map<qid, string[]> — findings from stories that failed to converge
const openFindings = new Map()

let stories = await refill()

while (stories.length > 0 || inflight.size > 0) {
  // Launch prepare() for every new ready story not already in flight
  for (const s of stories) {
    if (!inflight.has(s.qualified_id)) {
      log(`Launching prepare for ${s.qualified_id}: ${s.title}`)
      inflight.set(s.qualified_id, prepare(s))
    }
  }

  if (inflight.size === 0) break

  // Wait for whichever prepare() finishes next
  const result = await Promise.race(inflight.values())
  inflight.delete(result.qid)

  if (!result.ok) {
    // Story failed to converge — surface findings and halt
    openFindings.set(result.qid, result.open)
    log(`Story ${result.qid} did not converge. Open findings: ${result.open.join('; ')}`)
    // Surface all accumulated open findings and halt
    const summary = [...openFindings.entries()]
      .map(([q, fs]) => `${q}: ${fs.join(', ')}`)
      .join('\n')
    return {
      result: 'failed',
      reason: `Story ${result.qid} failed to converge after 3 attempts`,
      open_findings: summary,
    }
  }

  // Story converged — merge it serially into the trunk
  log(`Merging ${result.qid} (branch: ${result.build.branch}) into trunk`)
  const merge = await agent(
    `Merge story branch into the epic trunk.
cd ${trunk.worktree}
git checkout ${trunk.branch}
git merge --no-ff ${result.build.branch} -m "Merge story ${result.qid}: ${result.build.branch}"
Then run: git rev-parse HEAD
Return merged=true and merge_sha from git rev-parse HEAD output.
If there is a conflict, run git merge --abort and return merged=false with conflict description.`,
    { label: `merge:${result.qid}`, schema: MERGE_SCHEMA }
  )

  if (!merge.merged) {
    return {
      result: 'failed',
      reason: `Merge conflict for story ${result.qid}: ${merge.conflict}`,
    }
  }

  log(`Merged ${result.qid} at ${merge.merge_sha}. Running loom complete.`)

  // Mark story done in loom
  await agent(
    `Run: loom complete ${result.qid}`,
    { label: `complete:${result.qid}`, agentType: 'loom:story-executor' }
  )

  // Remove story worktree
  await agent(
    `Run in ${trunk.worktree}:
git worktree remove --force ${result.build.worktree}
git branch -d ${result.build.branch}`,
    { label: `cleanup:${result.qid}`, agentType: 'loom:story-executor' }
  )

  // Refill with any newly-unblocked stories
  stories = await refill()
}

log('All stories merged into trunk.')
