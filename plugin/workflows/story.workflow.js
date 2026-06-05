export const meta = {
  name: 'story',
  description: 'Single-story runner: build → review → validate convergence loop, then finalize (open a PR by default, or merge to main when requested)',
  phases: [
    { title: 'Execute',  detail: 'story-executor builds the story branch' },
    { title: 'Review',   detail: 'code-reviewer checks hygiene' },
    { title: 'Validate', detail: 'story-validator checks criteria and tests' },
    { title: 'Finalize', detail: 'open a PR (default) or merge to main' },
  ],
}

// ---- Inputs ----
// story_qid  — loom qid of the story to execute (required)
// finalize   — 'pr' (default) opens a PR; 'merge' merges + pushes to main

const story_qid = args.story_qid
if (!story_qid) throw new Error('story_qid is required')
const finalize = args.finalize ?? 'pr'
const doMerge = finalize === 'merge'

// ---- Schema helpers ----
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

// ---- Helpers ----

/** File a collated batch of fix-items ({title, body}) as new loom tasks on the
 *  story in a single agent, so the re-dispatched executor rediscovers them. */
async function fileFixes(story_qid, fixes) {
  const createCmds = fixes
    .map(f => `loom -y task create --title ${JSON.stringify(f.title)} --body ${JSON.stringify(f.body)} ${story_qid}`)
    .join('\n')
  await agent(
    `Run each of these commands in order; confirm each exits 0:\n${createCmds}`,
    { label: `file-fixes:${story_qid}` }
  )
}

// ---- prepare(): build → review → validate convergence loop (≤3 attempts) ----
// Mirrors epic.workflow.js: the retry loop lives INSIDE prepare(). Each attempt
// collates fix-items from BOTH the review and validate steps as local objects
// and files them via a single agent before re-dispatching the executor (which
// resumes its worktree and implements only the newly-filed tasks).
// Returns { ok: true, executor, attempts } on success, or
// { ok: false, attempts, reason } once retries are exhausted.

async function prepare(story_qid) {
  const MAX_ATTEMPTS = 3
  let attempt = 0
  let lastReason = ''

  while (attempt < MAX_ATTEMPTS) {
    attempt++
    log(`[${story_qid}] prepare attempt ${attempt}/${MAX_ATTEMPTS}`)

    // Phase: Execute
    phase('Execute')
    const executor = await agent(
      `story_qid=${story_qid} parent_branch=main`,
      { label: `story-executor:${attempt}`, agentType: 'loom:story-executor', schema: EXECUTOR_SCHEMA }
    )
    log(`Executor done: branch=${executor.branch}`)

    const fixes = []  // [{ title, body }]

    // Phase: Review
    phase('Review')
    const reviewer = await agent(
      `story_qid=${story_qid} branch=${executor.branch} trunk=main worktree=${executor.worktree}`,
      { label: `code-reviewer:${attempt}`, agentType: 'code-reviewer', schema: REVIEWER_SCHEMA }
    )
    if (!reviewer.clean) {
      for (const f of reviewer.findings) {
        fixes.push({
          title: `fix: ${f.title}`,
          body: `${f.detail}\n\nLocation: ${f.file}:${f.lines}`,
        })
      }
    }

    // Phase: Validate
    phase('Validate')
    const validator = await agent(
      `story_qid=${story_qid} branch=${executor.branch} worktree=${executor.worktree}`,
      { label: `story-validator:${attempt}`, agentType: 'story-validator', schema: VALIDATOR_SCHEMA }
    )
    if (validator.result !== 'ok') {
      for (const c of validator.criteria.filter(c => !c.pass)) {
        fixes.push({
          title: `fix: ${c.text}`,
          body: `Validation criterion failed.\n\nCriterion: ${c.text}\n\nEvidence: ${c.evidence}`,
        })
      }
    }

    if (fixes.length === 0) {
      return { ok: true, executor, attempts: attempt }
    }

    // File the collated fix-items so the next dispatch rediscovers them.
    lastReason = fixes.map(f => f.title).join('; ')
    log(`[${story_qid}] filing ${fixes.length} fix-task(s) (${lastReason})`)
    await fileFixes(story_qid, fixes)
  }

  log(`[${story_qid}] did not converge after ${MAX_ATTEMPTS} attempts`)
  return { ok: false, attempts: MAX_ATTEMPTS, reason: lastReason }
}

// ---- Run the convergence loop ----
const result = await prepare(story_qid)

if (!result.ok) {
  return {
    result: 'failed',
    story_qid,
    attempts: result.attempts,
    reason: result.reason,
  }
}

// ---- Convergence succeeded — finalize ----
const { executor } = result
const attempt = result.attempts
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
  // Merge + push path (only when args.finalize === 'merge').
  log(`Merging ${executor.branch} into main and pushing`)
  const MERGE_SCHEMA = {
    type: 'object',
    required: ['merged'],
    properties: {
      merged:   { type: 'boolean' },
      conflict: { type: 'string' },
    },
  }
  const merge = await agent(
    [
      `Merge the story branch into main and push. Run in order:`,
      `1. git fetch origin`,
      `2. git checkout main`,
      `3. git pull --ff-only origin main`,
      `4. git merge --no-ff ${executor.branch} -m "Merge ${executor.branch}: story ${story_qid}"`,
      ``,
      `If step 4 conflicts: you may resolve ONLY trivial, unambiguous conflicts`,
      `(non-overlapping added lines, lockfile/index unions, whitespace). If a`,
      `conflict touches real logic or there is ANY chance the correct resolution`,
      `depends on intent, run "git merge --abort" and return`,
      `{ "merged": false, "conflict": "<files and why>" } — do NOT push.`,
      ``,
      `On a clean (or trivially-resolved) merge, finish cleanup and push:`,
      `5. git push origin main`,
      `6. git branch -d ${executor.branch}`,
      `7. git worktree remove --force ${executor.worktree}`,
      `Return { "merged": true }.`,
    ].join('\n'),
    { label: 'merge-push', schema: MERGE_SCHEMA }
  )
  if (!merge.merged) {
    return {
      result: 'failed',
      story_qid,
      attempts: attempt,
      reason: `merge conflict: ${merge.conflict}`,
    }
  }
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
      `Branch: ${executor.branch}   Base: main`,
      ``,
      `1. cd ${executor.worktree}`,
      `2. git push -u origin ${executor.branch}`,
      `3. Compose a coherent PR body from the actual change — do NOT use a`,
      `   generic "automated PR" string. Read the story for intent`,
      `   (loom show ${story_qid} --json) and the diff for what shipped:`,
      `     git diff main...${executor.branch} --stat`,
      `     git log main..${executor.branch} --oneline`,
      `   Write a short Markdown body: one-paragraph summary + a "## Changes"`,
      `   bullet list grounded in the diff. Every claim must match a real change.`,
      `4. gh pr create --base main --head ${executor.branch} --title "story ${story_qid}: <short summary>" --body-file <tmpfile> and capture the URL`,
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
