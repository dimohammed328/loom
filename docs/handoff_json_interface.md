# Handoff: JSON bulk-ingestion interface for loom

Two new CLI commands (+ library API): `loom apply` for bulk item creation and
`loom dep apply` for bulk dependency wiring. JSON at the interface, markdown
at rest — the markdown backend and both CLAUDE.md invariants stay untouched;
these commands are ingestion only, and everything they write must round-trip
through `loom rebuild`.

## Why (context from the 2026-06-11 session)

- The streamlined /epic and /story skills (PR #16, branch
  `loom/streamline-epic-story`) materialize plans via N serial `loom create`
  calls + M `loom dep add` calls. Measured pain from session research: one
  epic ran ~75 serial loom invocations with 37 temp body files; another had a
  silently half-broken materialization batch.
- Decision: orchestrator writes JSON, CLI converts to the markdown store.
  Full JSON backend was considered and rejected (prose-heavy bodies are the
  big half of every item; escaped-string prose is unreadable/uneditable and
  diffs badly; `MARKDOWN_SPEC.md` is a public contract).
- Decision: **two commands, not one** — item creation is separate from dep
  wiring, and deps are declared against the real qids returned by creation
  (no forward-reference resolution inside the dep command).

## Command 1: `loom apply <plan.json>`

Creates a tree of items in one invocation. Input is a **flat item list** with
hierarchy via parent references — matches loom's hierarchy-agnostic model and
trivially supports "add stories to an existing epic" (parent = real qid):

```json
{
  "items": [
    {"ref": "epic",  "type": "epic",  "parent": "loom-app",
     "title": "Auth overhaul", "body": "## Summary\n…", "assignee": "<session-id>"},
    {"ref": "s1",    "type": "story", "parent": "epic",
     "title": "Login endpoint", "body": "## Summary\n…\n## Validation Criteria\n- [ ] …",
     "assignee": "<session-id>"},
    {                "type": "task",  "parent": "s1",
     "title": "Failing test for login", "body": "…"},
    {"ref": "s2",    "type": "story", "parent": "loom-app:backlog",
     "title": "Standalone story", "body": "…"}
  ]
}
```

- `ref` — local handle, unique within the file; required only for items used
  as a `parent` or needed in the output mapping (stories, usually); optional
  elsewhere (tasks, usually).
- `parent` — either a `ref` defined earlier in the list or an existing qid.
  A bare project qid as a story's parent targets its `backlog` epic (same as
  `loom story create`).
- Per-item fields: `type` (epic|story|task — project creation stays a
  separate command since it binds the workspace), `title` (required), `body`
  (markdown string, optional), `assignee` (optional), `tags` (optional list),
  `status` (optional, default `ready`).
- **Validate everything before writing anything**: refs unique, parents
  resolvable, titles non-empty, type/parent compatibility (epic→project,
  story→epic-or-project, task→story). Then create in file order (qid
  stability: `_next_sequential_id` allocates as it goes and scans archive).
- **stdout is bare JSON** (consistent with `create`'s bare-qid contract;
  human notes go to stderr):

```json
{"created": [{"ref": "epic", "qid": "loom-app:k3m9xwp", "type": "epic"},
             {"ref": "s1",   "qid": "loom-app:k3m9xwp:1", "type": "story"},
             {"ref": null,   "qid": "loom-app:k3m9xwp:1:1", "type": "task"}]}
```

- `--dry-run`: validate and print the would-be plan, create nothing.
- Mid-create failure (should be rare given pre-validation): print the partial
  `created` mapping on stdout, error to stderr, exit nonzero. **v1 does no
  rollback** — "Archive, not delete" is a non-negotiable and auto-`rm` of
  just-created files needs explicit user sign-off; revisit only if partial
  failures show up in practice.
- Exit codes: reuse the existing contract (`EXIT_NOT_FOUND=2` unknown parent
  qid, `EXIT_DUPLICATE=3`, `EXIT_INVALID_ID=5`, `EXIT_GENERIC=1`).

## Command 2: `loom dep apply <deps.json>`

```json
{"deps": [
  {"source": "loom-app:k3m9xwp:2", "on": "loom-app:k3m9xwp:1"},
  {"source": "loom-app:k3m9xwp:3", "on": "loom-app:k3m9xwp:1"}
]}
```

- All-or-nothing: verify every qid exists (exit 2), reject any dep on a
  project (containers aren't work units — existing rule), run **one batch
  cycle check** over existing graph + all new edges before applying any
  (exit `EXIT_CYCLE=4`, print the offending cycle), then apply all edges.
- stdout: `{"added": N}`; per-edge `src -> tgt` notes to stderr.

## Library surface

Thin CLI wrappers per repo convention; the real logic goes in the library:

- `api.py`: something like `Loom.apply(plan: dict)` and
  `Loom.add_dependencies(edges: list[tuple[str, str]])` (implementer's call
  on names/signatures).
- `deps.py` has per-edge cycle checking; the batch check should validate the
  whole edge set at once rather than relying on insertion order.
- Both commands must update `.loom/state.json` last-touched like every other
  CLI mutation (`state.py`), and must never prompt (no pickers by
  construction; `-y` irrelevant but harmless).

## Constraints checklist (from repo CLAUDE.md)

- Markdown stays source of truth; `loom rebuild` after `apply` must be a
  no-op reconciliation.
- Document both JSON schemas in a new `docs/JSON_INTERFACE.md` as a public
  contract (like `MARKDOWN_SPEC.md`, which is unaffected — no format change).
- Tests: e2e through both library and CLI surfaces (`tests/test_e2e.py`
  addition per convention), CliRunner with `--root`, and parametrized reject
  cases: duplicate ref, unknown parent ref/qid, bad type/parent combo,
  missing title, batch cycle, dep-on-project, malformed JSON.
- `web/lib` TS mirror: defer — the server has no bulk-create path today;
  note it as intentionally deferred, don't stub it.
- Dev mode: no backwards-compat shims; if any existing helper gets renamed,
  rename it cleanly.

## Follow-up once the commands land (separate small story)

Shrink the materialization phases of the plugin skills to use them:
`plugin/skills/epic/SKILL.md` Phase 4 and `plugin/skills/story/SKILL.md`
Phase 3 become: write `plan.json` → `loom apply` → build `deps.json` from
the returned mapping → `loom dep apply` → `loom validate` + `loom tree`.
Update the "Loom CLI facts" box in the epic skill accordingly, and check
`tests/test_plugin_structure.py` still passes (its guarded phrases don't
mention materialization, but verify).

## Open decisions for the implementing session

1. Command naming: `loom apply` / `loom dep apply` recommended; `loom import`
   or `loom plan apply` are alternatives if `apply` reads too kubectl-ish.
2. Whether `apply` should accept stdin (`loom apply -`) in addition to a file
   path — cheap and nice for orchestrators, recommended.
3. Whether `status` belongs in the v1 item schema or items always start
   `ready` (recommendation: allow it; it's one field and `update` already
   accepts arbitrary statuses).

## Suggested kickoff

Start a fresh session in `~/tech/loom` (after merging PR #16 or branching
from it) and run `/story` with this document as the description — it should
groom into one story with roughly five tasks: apply schema+validation,
apply create+output, dep apply with batch cycle check, JSON_INTERFACE.md
docs, e2e + reject tests.
