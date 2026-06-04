# CLAUDE.md — Loom Web frontend

Guidance for Claude (and humans) working in the loom web GUI frontend.
Scope is this directory (`src/loom_web/frontend/`) only; the repo-root
`CLAUDE.md` governs the Python library/CLI and is the higher authority.

## What this is

A single-page **React 18 + TypeScript** app, bundled with **Bun** (not
Vite/webpack), that renders a **read-only** view of loom data. It talks to
the FastAPI backend in `src/loom_web/` over a JSON API and a WebSocket. The
visual target is the reference design under `src/ui/handoff/` — match the
*output*, never copy its code.

**Read-only by design.** The UI never mutates loom items. There are no
write endpoints, no drag-to-change-status, no edit forms. Background AI
agents change the `.md` files; the UI reflects those changes live.

## Commands

Run these from `src/loom_web/frontend/`. Bun must be installed.

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Production build → `../static/` | `bun run build` |
| Watch-rebuild (dev) | `bun run dev` |
| Unit tests | `bun test` |
| Typecheck | `bunx tsc --noEmit` |

`bun run build` bundles `src/main.tsx` to `../static/main.js` + `main.css`
(minified, fixed names). **FastAPI serves that built bundle** — there is no
separate frontend dev server and **no HMR**. `bun run dev` re-emits the
bundle on save, but you still hard-refresh the browser to see code changes.
Serve the app from the repo root with `uv run python -m loom_web` (auto-
reloads Python; serves the prebuilt `static/`).

Typecheck and `bun test` must pass before declaring frontend work complete.

## Architecture & data flow

```
main.tsx ──initTheme()──> renders <App/>
  App (AppProvider)
   ├─ WsConnector        // opens /ws, pushes payloads into the store
   ├─ TopBar             // project switcher · Board/Table/Graph tabs · theme toggle · repo link
   ├─ ViewRouter         // board → BoardView | table → TableView | graph → DagView
   └─ ConnectedItemModal // opens when store.openQid is set
```

- **State** lives in one React context (`state/store.tsx`,
  `useAppStore()`). No Redux. The store holds `projects`,
  `currentProject`, `view`, `openQid`, `collapseControl`, and
  `itemsById` (flat qid→`ItemNode` map for the current project).
- **Views fetch their own data.** Each view calls `getProjectTree(project)`
  from `api/client.ts` in a `useEffect`, then derives its shape with a
  **pure model function** (`boardModel`, `tableModel`, `dagLayout`).
- **Live updates** flow: backend `/ws` → `ws/client.ts` parses → `App`'s
  `WsConnector` calls `store.applyWsPayload` → `state/itemsReducer.ts`
  replaces/removes the item by qid → all views re-render. No diffing; the
  payload is the whole item record (minus body), or `{qid, deleted:true}`.

## File map

```
src/
  main.tsx                entry: initTheme() then mount <App/>
  App.tsx                 shell: AppProvider, WsConnector, ViewRouter, modal
  api/client.ts           typed fetch wrappers + TS types mirroring schemas.py
  state/
    store.tsx             React-context store (useAppStore)
    itemsReducer.ts       pure: setItems(), applyWsPayload()  ← unit-tested
    wsIntegration.ts      pure: shouldRefetchModal()          ← unit-tested
  ws/client.ts            WS client: connect/disconnect, backoff reconnect,
                          parseWsPayload()/computeBackoffMs() (pure, tested)
  theme.ts                light/dark via [data-theme]; persists to localStorage
  status.ts               statusColor() → CSS-var tokens, neutral fallback
  boardModel.ts           tree → epic×status matrix (pure)
  tableModel.ts           tree → flat collapsible rows (pure)
  dagLayout.ts            stories+deps → React Flow nodes/edges via dagre (pure)
  progress.ts             done/total/blocked counts (pure)
  components/
    TopBar / BoardView / TableView / DagView / ItemModal      view components
    EpicRowHeader / StoryCard / TableRow / StoryNode / EpicPickerDrawer
    *Helpers.ts, enterClass.ts, statusChip.ts                 pure helpers (tested)
  styles/
    tokens.css            design system: themes + status palette + base styles
    motion.css            enter animation + status crossfade (reduced-motion gated)
```

## Conventions

- **Push logic into pure `.ts` modules; keep `.tsx` thin.** Anything
  worth testing — model transforms, layout math, helpers — lives in a
  plain `.ts` file with a sibling `*.test.ts`. Components consume them and
  stay presentational. This is *the* testing convention: see
  `boardModel.ts`/`boardModel.test.ts`, `tableRowHelpers.ts`,
  `itemModalHelpers.ts`, `enterClass.ts`, `statusChip.ts`.
- **All colors come from CSS custom properties** in `tokens.css`, never
  hardcoded hex in components. Status colors go through `statusColor()`,
  which returns `var(--st-*)` tokens and falls back to neutral
  (`--text-3`/`--surface-2`) for any unrecognized status — never throw,
  never assume a fixed status enum (loom statuses are open-ended).
- **TS is strict** (`strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`). `moduleResolution: bundler`, so
  `.ts`/`.tsx` imports may include the extension.
- **Components return `React.JSX.Element`**; props are explicit interfaces.

## Live updates (WS)

- `ws/client.ts` is framework-agnostic and pure-testable: `connect()`,
  `disconnect()` (disables reconnect), exponential backoff capped at 30 s,
  and `parseWsPayload()` which rejects non-objects / missing `qid`.
- The socket path `/ws` is resolved to an absolute `ws(s)://` URL against
  `window.location` at connect time, so it works behind the same FastAPI
  origin with no config.
- `WsConnector` mounts once inside `AppProvider`. It keeps refs to
  `openQid`/`applyWsPayload` so the message callback isn't recreated each
  render. An **open modal** is refreshed via a module-level escape-hatch
  ref (`registerModalRefetch` / `_modalRefetchRef` in `App.tsx`) — a
  deliberate single-callback shortcut instead of another context.

## Animations

`styles/motion.css` defines two primitives, both suppressed under
`prefers-reduced-motion`:
- `.loom-enter` — fade+slide-in for newly-present cards/rows/nodes
  (applied via `components/enterClass.ts`).
- `.loom-status-chip` — color crossfade on status pills/dots so live
  status changes transition smoothly without a remount (`statusChip.ts`).

Keep new motion minimal and always add it to the reduced-motion block.

## Gotchas

- **No HMR / no dev server.** `bun run dev` only re-bundles to
  `../static/`; refresh the browser yourself. The frontend is *always*
  served as the built bundle by FastAPI.
- **Project segment is the slug, not the qid.** `getProjectTree` sends
  `qid.split(":")[0]` to `/api/projects/{slug}/tree`.
- **Theme naming:** logical `dark` maps to `[data-theme="linear"]` and
  `light` to `notion` (see `theme.ts`). `tokens.css` also carries
  `slate`/`editorial` themes and `[data-accent]`/`[data-density]` knobs
  from the reference design — they are **not** wired to any UI control;
  shipped scope is the Notion-light / Linear-dark toggle only. Don't
  surface the extras without a product decision.
- **`bun test` + JSX:** the test setup runs pure `.ts` logic; rendering
  `.tsx` under `bun test` can fail on `react/jsx-dev-runtime` resolution.
  Test behavior through the extracted pure helpers, not by mounting
  components.
- **Build output (`../static/`) is committed.** Rebuild and commit it when
  shipping frontend changes, or the served app goes stale.
- The macOS `/tmp`→`/private/tmp` symlink trap that affects the live
  watcher is a **backend** concern (use a non-symlinked `$LOOM_DIR`); it
  does not involve this directory.
