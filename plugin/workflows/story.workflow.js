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
