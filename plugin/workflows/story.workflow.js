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

// ---- Convergence succeeded — finalize ----
const { executor } = result
phase('Finalize')

// Final validation on the story branch before touching main
log('Running final story-validator before finalize')
const finalValidation = await agent(
  `story_qid=${story_qid} branch=${executor.branch} worktree=${executor.worktree}`,
  { label: 'final-validator', agentType: 'story-validator', schema: VALIDATOR_SCHEMA }
)
if (finalValidation.result !== 'ok') {
  const failed = finalValidation.criteria.filter(c => !c.pass).map(c => c.text).join('; ')
  return {
    result: 'failed',
    story_qid,
    attempts: attempt,
    reason: `final-validation: ${failed}`,
  }
}

if (doMerge) {
  // Merge + push path (only when explicitly requested via args.merge=true)
  log(`Merging ${executor.branch} into main and pushing`)
  await agent(
    [
      `Run these commands in order and confirm each succeeds:`,
      `1. git fetch origin`,
      `2. git checkout main`,
      `3. git pull --ff-only origin main`,
      `4. git merge --no-ff ${executor.branch} -m "Merge ${executor.branch}: story ${story_qid}"`,
      `5. git push origin main`,
      `6. git branch -d ${executor.branch}`,
      `7. git worktree remove --force ${executor.worktree}`,
    ].join('\n'),
    { label: 'merge-push' }
  )
  return {
    result: 'ok',
    story_qid,
    branch: executor.branch,
    merged_to: 'main',
    attempts: attempt,
  }
} else {
  // Default: open a PR
  log(`Opening PR for ${executor.branch} → main`)
  const PR_SCHEMA = {
    type: 'object',
    required: ['pr_url'],
    properties: { pr_url: { type: 'string' } },
  }
  const pr = await agent(
    [
      `Push the branch and open a GitHub PR, then return the PR URL.`,
      `Branch: ${executor.branch}`,
      `Base: main`,
      `Commands:`,
      `1. git push -u origin ${executor.branch}`,
      `2. gh pr create --base main --head ${executor.branch} --title "story ${story_qid}" --body "Automated PR for loom story ${story_qid}." and capture the URL`,
      `Return JSON: { "pr_url": "<url>" }`,
    ].join('\n'),
    { label: 'open-pr', schema: PR_SCHEMA }
  )
  return {
    result: 'ok',
    story_qid,
    branch: executor.branch,
    pr_url: pr.pr_url,
    attempts: attempt,
  }
}
