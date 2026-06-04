export const meta = {
  name: 'story',
  description: 'Single-story runner: build → review → validate convergence loop, then merge to main and finalize via PR',
  phases: [
    { title: 'Execute',  detail: 'story-executor builds the story branch' },
    { title: 'Review',   detail: 'code-reviewer checks hygiene' },
    { title: 'Validate', detail: 'story-validator checks criteria and tests' },
    { title: 'Finalize', detail: 'merge to main and open PR' },
  ],
}

// ---- Inputs ----
// story_qid  — loom qid of the story to execute (required)
// merge      — if "true", merge + push instead of opening a PR (default: PR)

const story_qid = args.story_qid
if (!story_qid) throw new Error('story_qid is required')
const doMerge = args.merge === 'true'

// ---- Schema helpers ----
const EXECUTOR_SCHEMA = {
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

const REVIEWER_SCHEMA = {
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

// ---- Helpers ----

/** File findings as new loom tasks on the story so the executor re-runs them. */
async function fileFindings(story_qid, findings) {
  for (const f of findings) {
    const body = `${f.detail}\n\nSeverity: ${f.severity}`
    await agent(
      `Run: loom -y task create --title ${JSON.stringify(f.title)} --body ${JSON.stringify(body)} ${story_qid}`,
      { label: `file-finding:${f.title.slice(0, 30)}` }
    )
  }
}

/** File failed validation criteria as new loom tasks on the story. */
async function fileCriteria(story_qid, criteria) {
  for (const c of criteria.filter(c => !c.pass)) {
    const body = `Validation criterion failed.\n\nCriterion: ${c.text}\n\nEvidence: ${c.evidence}`
    await agent(
      `Run: loom -y task create --title ${JSON.stringify('Fix: ' + c.text.slice(0, 60))} --body ${JSON.stringify(body)} ${story_qid}`,
      { label: `file-criterion:${c.text.slice(0, 30)}` }
    )
  }
}

// ---- prepare(): execute → review → validate for one story attempt ----
// Returns { ok: true, executor } on success, or { ok: false, reason } on failure.

async function prepare(story_qid) {
  // Phase: Execute
  phase('Execute')
  log(`Dispatching story-executor for ${story_qid}`)
  const executor = await agent(
    `story_qid=${story_qid} parent_branch=main`,
    { label: 'story-executor', agentType: 'loom:story-executor', schema: EXECUTOR_SCHEMA }
  )
  log(`Executor done: branch=${executor.branch}  commits=${executor.commits.length}`)

  // Phase: Review
  phase('Review')
  const reviewer = await agent(
    `story_qid=${story_qid} branch=${executor.branch} trunk=main worktree=${executor.worktree}`,
    { label: 'code-reviewer', agentType: 'code-reviewer', schema: REVIEWER_SCHEMA }
  )
  if (!reviewer.clean) {
    const errors = reviewer.findings.filter(f => f.severity === 'error')
    if (errors.length) {
      log(`Review found ${errors.length} error(s) — filing as tasks`)
      await fileFindings(story_qid, errors)
      return { ok: false, reason: `review:${errors.map(e => e.title).join('; ')}` }
    }
    // Warnings/suggestions are surfaced but do not block
    log(`Review warnings (non-blocking): ${reviewer.findings.length}`)
  }

  // Phase: Validate
  phase('Validate')
  const validator = await agent(
    `story_qid=${story_qid} branch=${executor.branch} worktree=${executor.worktree}`,
    { label: 'story-validator', agentType: 'story-validator', schema: VALIDATOR_SCHEMA }
  )
  if (validator.result !== 'ok') {
    log(`Validation failed — filing criteria as tasks`)
    await fileCriteria(story_qid, validator.criteria)
    return { ok: false, reason: `validation:${validator.criteria.filter(c => !c.pass).map(c => c.text).join('; ')}` }
  }

  return { ok: true, executor }
}

// ---- Convergence loop (≤3 attempts) ----
const MAX_ATTEMPTS = 3
let attempt = 0
let result = null

while (attempt < MAX_ATTEMPTS) {
  attempt++
  log(`Attempt ${attempt}/${MAX_ATTEMPTS} for story ${story_qid}`)
  result = await prepare(story_qid)
  if (result.ok) break
  if (attempt < MAX_ATTEMPTS) {
    log(`Attempt ${attempt} failed (${result.reason}) — re-running executor with fix-tasks`)
  }
}

if (!result.ok) {
  return {
    result: 'failed',
    story_qid,
    attempts: attempt,
    reason: result.reason,
  }
}
