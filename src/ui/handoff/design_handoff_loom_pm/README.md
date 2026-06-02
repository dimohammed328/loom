# Handoff: Loom — Project Management GUI

## Overview
Loom is a web-based project-management GUI for a markdown/CLI-native project tool. Its data model is a four-level hierarchy: **project → epic → story → task**, with cross-cutting dependencies between stories. The GUI is always scoped to **one project at a time** and presents that project through three switchable views:

1. **Board** — a Kanban matrix: epics are sticky row-headers down the left, statuses are columns across the top, story cards sit in the cells (drag to change status/epic).
2. **Table** — a collapsible multi-index tree (epic ▸ story ▸ task) with Progress and Status columns.
3. **Graph** — an Airflow-style dependency DAG of the **stories within one epic**, plus a collapsible epic-picker drawer.

A top bar holds a working **project switcher** and the three view tabs. Clicking any item (card, row, or node) opens a unified **detail modal** that works for epics, stories, and tasks. A **Tweaks panel** exposes theme/density/typeface/node-style/agent-icon/epic-review options.

Distinctive domain concepts to preserve:
- **Assignees are AI agent sessions, not people** — shown as a neutral agent-icon badge + a `sess_xxxxxx` id (never a person's name/avatar).
- **Fully-qualified ids everywhere** — every item shows its path id (`project:epic:story[:task]`) rendered with a stylized hashtag glyph (not a literal `#` character).
- **Stories never enter "in review."** Story statuses are only `ready · in progress · blocked · done`. **"In review" is an epic-level sign-off gate.** An epic has a `review` lifecycle: `active → in review → done` (with a reviewer session + date).

---

## About the Design Files
The files in this bundle are **design references created in HTML/React-via-Babel** — runnable prototypes that show the intended look and behavior. **They are not production code to copy verbatim.** The task is to **recreate these designs in the target codebase's environment** using its established framework, component library, state management, and styling conventions. If no environment exists yet, pick an appropriate stack (the prototype is plain React 18 + CSS variables, which ports cleanly to React/Next, Vue, Svelte, etc.).

The prototype loads React + Babel from CDNs and splits components across `.jsx` files that share globals via `window`. In a real codebase you'd convert these to proper ES modules/imports; the **component boundaries and CSS are the valuable part**.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, interactions, and copy are all specified. Recreate the UI pixel-accurately using the codebase's libraries. Exact token values are listed under **Design Tokens** below and live in `styles.css`.

---

## Data Model

```
Project { id, title, subtitle, repo, default_branch, icon, epics[] }
Epic    { id, title, accent, review?, reviewer?, reviewDate?, stories[] }
Story   { id, title, status, assignee, tags[], updated, depends_on[], tasks[] }
Task    { id, title, status, assignee, updated }
```

- **Story `status`**: one of `"ready" | "in progress" | "blocked" | "done"`. (No "in review".)
- **Epic `review`**: `"active" | "in review" | "done"` (default `"active"` when absent). `reviewer` is an agent-session key; `reviewDate` is a display string.
- **`depends_on`**: array of fully-qualified story ids, e.g. `["helios:k7m2x9p:2"]`. Only deps **within the same epic** are drawn in the Graph.
- **`assignee`**: a key into the agent-session map (`PEOPLE` in `data.js`), each `{ session: "sess_xxxxxx", hue }`. The hue is currently unused (agent badges are neutral by request).
- **Fully-qualified id (qid)**: `project:epic:story:task` joined by `:`. Epic qid = `project:epic`, story qid = `project:epic:story`, task qid = `project:epic:story:task`.
- **Epic display status** (`epicDisplayStatus` in `shared.jsx`): if `review === "done"` → `done`; if `review === "in review"` → `in review`; else roll up from story statuses (all done→done, any blocked→blocked, any in progress→in progress, else ready).

Sample data (3 projects: Helios, Orbit, Atlas) lives in `data.js`, with item descriptions in a `BODIES` map keyed by qid.

---

## Screens / Views

### Top Bar (52px tall, sticky)
- **Left:** project switcher — project title (15px / 650 weight) + chevron, in a hover-highlighted button. Clicking opens a 290px dropdown listing all projects (icon tile, title, subtitle, check on current). Selecting a project switches scope and resets to Board view.
- Divider (1px, 22px tall), then **view tabs**: Board / Table / Graph — each an icon + label (13.5px), 52px tall, active tab has a 2px bottom border in `--text` (or `--tab-active-bd` in Linear theme) and 600 weight.
- **Right:** GitHub repo link (`Icon.github` + `owner/repo`, muted) and contextual controls (Table shows Expand all / Collapse all; Graph shows nothing here — its epic picker is the drawer).
- Background: `color-mix(--bg 80% transparent)` with `backdrop-filter: blur(6px)`.

### View 1 — Board (Kanban matrix)
- **CSS grid**: `grid-template-columns: var(--epic-col) repeat(N_statuses, minmax(244px, 1fr))`. `--epic-col` = 216px (184px compact).
- **Header row** (sticky top): top-left "Epics N" corner cell + one sticky column header per status. Each status header = status checkbox glyph + label (14px/600) + count, with a 2px bottom rule.
- **Epic rows**: the first cell of each row is a **sticky-left epic row-header** containing:
  - chevron + epic title (14px/600; title click opens epic modal, chevron/row click toggles collapse),
  - the qid chip (`#project:epic`),
  - a **status-distribution bar** (see Shared Components),
  - a meta line `"<done>/<total> complete · <n> blocked"`,
  - a **review badge** when `review !== "active"`: purple "In review" chip (`Icon.review`) or green "Accepted" chip (`Icon.accepted`).
- **Cells** hold **story cards**. Collapsing an epic replaces its cells with a muted "N stories hidden" row.
- A full-width 1px **separator** + spacing sits between epic rows; a 16px gap sits between the header row and the first epic.
- **Story card** (`.kcard`): white surface, 1px border, `--radius-sm`, `--card-shadow`; padding `var(--pad-card)`. Contents:
  - title (13.5px / 550),
  - tag chips (if any),
  - a bottom block: qid chip on its own line, then **either** a task meter (if the story has tasks) **or** a "blocked"/"N deps" indicator — the task meter sits on its own row, left-aligned, below the qid.
  - `cursor: grab`; dragging sets opacity .4; click opens the story modal.

### View 2 — Table (multi-index tree)
- A `table-layout: fixed` table. Columns: **Name 40% · Progress 22% · Status 20% · Updated 18%.**
- Header cells: 11.5px uppercase, letter-spacing .05em, `--text-3`, sticky top with bottom border.
- Rows are flattened from the tree in order: epic row, then (if expanded) its story rows, then (if expanded) each story's task rows.
  - **Epic row**: tinted `--surface-2` background; Name = chevron + bold title (650) + qid; Progress = distribution bar + `<done>/<total>` (bold) [+ ` · N blocked`]; Status = `epicDisplayStatus` tag; Updated = latest story date.
  - **Story row**: Name indented 26px, title 500 weight; Progress = task meter (or "—"); Status = status tag; Updated.
  - **Task row**: Name indented 52px, title `--text-2`; Progress "—"; Status = status tag; Updated.
- Row height `var(--row-h)` (36px airy / 28px compact). Chevron toggles expand; title text (`.tw-open`) opens the modal. **No EPIC/STORY/TASK type tags** in rows.
- Expand all / Collapse all controls live in the top bar; stories start collapsed (tasks hidden) by default.

### View 3 — Graph (dependency DAG)
- Scoped to **one epic**; nodes = that epic's **stories**; edges = `depends_on` within the epic.
- **Layout** (`computeLayout` in `DagView.jsx`): layered left→right; a node's layer = longest dependency path from a root. Node width 218px, horizontal gap 92px, vertical gap 30px, padding 56px. Columns vertically centered. Edges are cubic Béziers with an arrowhead marker; stroke `--border-strong`.
- **Right drawer** (epic picker): 280px wide, collapsible to a 46px rail. Top row = a search input + collapse toggle. Body = one **epic card** per epic: title, qid, status-distribution bar, `"<done>/<total> complete · N blocked"`. Active epic card is outlined. Search filters by title/id.
- **Node styles** (Tweak `nodeStyle`, default **checklist**):
  - **checklist** (default): border tinted to the story's status color; rows are an aligned left icon column (18px slot) + content — row 1 status checkbox glyph + title, row 2 agent badge + `sess_xxxxxx`, then a bottom block with the qid and (below it, left-aligned) the task meter. Node height 116px.
  - **ports**: node-editor look — input ring (left) / output dot (right) connectors, a status pill + qid header, title, and a footer "(N upstream) · (N/N tasks)". Height 110px.
  - **spine**: a status ring on the left edge as the connection terminal, title + status + qid. Height 86px.
- Every node is clickable → opens the story modal.

### Detail Modal (unified — epic / story / task)
Opened with a qid string; `resolveItem(qid)` (in `ItemModal.jsx`) resolves the level + ancestors + the item. Centered dialog, max-width 620px, scrim with blur, Esc / click-away / × closes. Sections (render conditionally by level):
- **Header**: a type pill (`Epic`/`Story`/`Task`, color-coded) + qid chip; close button.
- **Breadcrumb**: project ▸ epic ▸ [story ▸ task].
- **Title** (23px / 650).
- **Epic review treatment** — only for epics; switchable via Tweak `epicReview` (default **banner**):
  - **banner** (default): a full-width strip under the title. `in review` → soft-purple "In review — N/N stories complete · awaiting sign-off" + a pulsing dot + reviewer session. `done` → green "Accepted — reviewed & signed off · <date>" + reviewer. `active` → no banner.
  - **stepper**: an Active → In Review → Done tracker (completed stages checked/green, current stage filled dark, future muted).
  - **split**: Status field shows the *work* rollup, and a separate **Review** meta field shows an "In review"/"Accepted"/"Not yet" chip + reviewer — keeping completion and acceptance as independent axes.
- **Meta strip**: Status (status tag; for epics, review-aware per the concept), Assignee (agent badge + session, or "—"), Updated, Progress (epics: `<done>/<total> done`), Tags.
- **Description**: prose from `BODIES[qid]` (or muted "No description yet.").
- **Dependencies** (stories only): "Depends on" (upstream) and "Blocks" (downstream) lists; each entry = status glyph + title + qid, clickable to navigate the modal to that item.
- **Children**: epic → "Stories" list; story → "Tasks" list; each row clickable.

---

## Shared Components (`shared.jsx`)
Recreate these as reusable components in the target stack:
- **StatusGlyph(status)** — a markdown-checkbox SVG that encodes status: `done` = filled box + check, `blocked` = box + ✕, `in progress` = box + half-fill, `in review` = box + center dot, `ready` = empty box. Color = the status dot color.
- **StatusTag(status)** — StatusGlyph + status label, colored by status.
- **StatusPill(status, {solid})** — pill form (soft bg + fg, or solid fg bg + white text).
- **StatusDistribution(stories)** — a single horizontal bar split into proportional segments per status (segment `flex-grow` = count, colored by status dot). Used in board epic headers, table epic rows, and graph drawer cards.
- **TaskMeter(tasks)** — a row of small ticks (one per task; done = `--text-2`, not-done = `--border-strong`) + a `done/total` count. **Neutral grays — not tied to status color.**
- **AgentBadge(who)** — a neutral rounded-square chip with the selected agent icon (Tweak `agentIcon`: terminal[default] / bot / spark / hex). Background `--surface-2`, color `--text-2`. Title = the session id.
- **Qid(id)** — a stylized hashtag glyph (`Icon.hash`, a slanted `#`) + the id text in mono. **Never** render a literal `#` character.
- **TagChip(tag)** — soft pastel chip; color derived in OKLCH from a per-tag hue (`TAG_HUES`), saturation scaled by `--tag-sat`.
- **Icon** — inline-SVG set (chevrons, board/table/graph, github, search, x, hash, dep, block, review, accepted, check).

---

## Interactions & Behavior
- **View switching**: Board / Table / Graph tabs swap the active view; scoped to current project.
- **Project switcher**: dropdown; selecting switches project, resets to Board, reinitializes collapse state, points Graph at the project's first epic.
- **Board drag-and-drop**: HTML5 drag. Drop a story card in another cell → set its status (horizontal move) and/or reassign its epic (vertical move). Drop target highlights (`--hover` bg + inset ring). On drop, mutate the project's stories arrays.
- **Board epic rows**: chevron/row toggles collapse; title text opens the epic modal.
- **Table**: chevron toggles expand/collapse per node; title text opens modal; Expand all / Collapse all in top bar.
- **Graph**: drawer epic cards switch the graphed epic; search filters the list; drawer collapses to a rail. Nodes open the story modal.
- **Modal**: opens from any item; child/dependency rows navigate the modal to that item (stack-free; just re-resolve); Esc/scrim/× close. (No keyboard focus-trap implemented in the prototype — add one for production accessibility.)
- **Transitions**: hovers ~.12s; modal scrim fade .14s, panel rise .16s `cubic-bezier(.2,.7,.3,1)`; review banner has a 1.8s pulse (disabled under `prefers-reduced-motion`).

## State Management
Local React state in `App.jsx` (lift to your store as appropriate):
- `projects` — working copy of all projects (mutated by board drag).
- `currentId` — active project id.
- `view` — `"board" | "table" | "graph"`.
- `openQid` — qid string of the item shown in the modal (or null).
- `dagEpicId` — which epic the Graph shows.
- `collapsed` — map of qid→bool for table/board collapse.
- `projMenu` — project dropdown open/closed.
- Tweak state (`useTweaks`): `theme, accent, density, font, nodeStyle, agentIcon, epicReview`.
- Two values are read globally during render by shared components: `window.LOOM_AGENT_ICON` and the modal's `reviewStyle` prop. In a real app, pass these via context/props instead of globals.

---

## Design Tokens

All tokens are CSS custom properties on `<html>`, switched by `data-theme` / `data-accent` / `data-density`. **Default theme = Notion (warm).** Full set in `styles.css`.

### Theme: Notion (default, warm)
| Token | Value |
|---|---|
| `--bg` | `#FBFBFA` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F7F6F3` |
| `--hover` | `#F1F0ED` |
| `--border` | `#EAE8E3` |
| `--border-strong` | `#DCD9D2` |
| `--text` | `#37352F` |
| `--text-2` | `#74706A` |
| `--text-3` | `#A39E94` |
| `--card-shadow` | `0 1px 2px rgba(15,15,15,0.04)` |
| `--pop-shadow` | `0 6px 22px rgba(15,15,15,0.10), 0 1px 3px rgba(15,15,15,0.06)` |
| `--radius` / `--radius-sm` | `9px` / `6px` |

Other themes (optional, all in `styles.css`): **Slate** (cool neutrals, Hanken Grotesk), **Editorial** (warm paper `#F5F1E9`, Newsreader serif headings), **Linear** (dark: `--bg #0C0D10`, `--surface #161719`, indigo active-tab `#7C8AF0`).

### Status colors — soft (default `--accent: soft`)
| Status | bg | fg | dot |
|---|---|---|---|
| ready | `#EAF1FB` | `#3F6CA8` | `#6699E0` |
| in progress | `#FBF2E0` | `#976715` | `#E0A338` |
| in review *(epic only)* | `#F1EBFA` | `#6B50A4` | `#9B79D9` |
| blocked | `#FBEAEA` | `#B04F4F` | `#E07A7A` |
| done | `#E8F3EC` | `#4A8058` | `#6FAE7E` |

Vivid variant (`--accent: vivid`) uses punchier values (e.g. done dot `#22C55E`, blocked dot `#EF4444`) — see `styles.css`.

### Typography
- Body font (Notion): `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; base 14px / line-height 1.45.
- Mono (qids, sessions): `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`.
- Typeface Tweak options (Google Fonts): Schibsted Grotesk, Bricolage Grotesque, Instrument Sans, IBM Plex Sans, Space Grotesk; "Theme default" defers to the theme pairing.
- Key sizes: modal title 23px/650; view titles & epic titles 14px/600–650; card/row titles 13.5px/550; meta 11.5–12.5px; qid/mono 10.5px.

### Spacing / density (`data-density`, default `airy`)
| Token | airy | compact |
|---|---|---|
| `--gap` | 12px | 7px |
| `--pad-card` | 11px | 7px |
| `--card-gap` | 8px | 5px |
| `--row-h` | 36px | 28px |
| `--epic-col` | 216px | 184px |

### Radii / shadows
`--radius` 7–10px (per theme), `--radius-sm` 5–7px; pill/chip = `999px`; shadows via `--card-shadow` / `--pop-shadow`.

---

## Assets
- **No external image assets.** All icons are inline SVGs defined in `shared.jsx` (`Icon`, `StatusGlyph`, `AGENT_ICONS`). The GitHub mark is an inline SVG.
- **Fonts**: Google Fonts (Hanken Grotesk, Newsreader, Schibsted Grotesk, Bricolage Grotesque, Instrument Sans, IBM Plex Sans, Space Grotesk) — loaded via `<link>` in `Loom.html`. Notion theme uses the system font stack (no webfont needed).
- Replace the sample data in `data.js` with real Loom project data.

---

## Files
| File | What it contains |
|---|---|
| `Loom.html` | Entry point — fonts, CSS link, React/Babel script tags, script order. |
| `styles.css` | All tokens, theme/accent/density variants, and every component's CSS. **Single source of truth for visual values.** |
| `data.js` | Sample projects/epics/stories/tasks, agent-session map (`PEOPLE`), status list, and `BODIES` (qid→description). |
| `shared.jsx` | Shared primitives: StatusGlyph, StatusTag, StatusPill, StatusDistribution, TaskMeter, AgentBadge, Qid, TagChip, Icon, and helpers (`statusVars`, `epicSummary`, `epicDisplayStatus`, `qid`). |
| `KanbanView.jsx` | Board (matrix) view + epic row-headers + story cards. |
| `TableView.jsx` | Table (multi-index tree) view. |
| `DagView.jsx` | Graph view: layout algorithm, node styles, epic drawer. |
| `ItemModal.jsx` | Unified detail modal + the three epic-review concepts. |
| `App.jsx` | Top bar, project switcher, view routing, state, modal mount, Tweaks panel. |
| `tweaks-panel.jsx` | The Tweaks panel shell (prototype-only; drop in production — replace with real settings if desired). |

### Notes for implementation
- The prototype shares components across files via `window` globals and runs JSX through in-browser Babel. **Convert to real imports/modules** in the target codebase.
- `tweaks-panel.jsx` is a prototyping affordance for comparing design options live — it is **not** a product feature. Pick the chosen defaults (theme **Notion**, accent **soft**, density **airy**, node style **checklist**, agent icon **terminal**, epic-review **banner**) and you can drop the panel entirely.
- Preserve the three domain rules called out in the Overview (agent-session assignees, stylized-hashtag qids, epic-only "in review").
