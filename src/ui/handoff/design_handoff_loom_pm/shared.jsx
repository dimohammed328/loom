/* Loom PM — shared primitives & helpers (exports to window) */

const STATUS_META = {
  "ready":       { label: "Ready",       key: "ready" },
  "in progress": { label: "In Progress", key: "progress" },
  "in review":   { label: "In Review",   key: "review" },
  "blocked":     { label: "Blocked",     key: "blocked" },
  "done":        { label: "Done",        key: "done" },
};

function statusVars(status) {
  const k = (STATUS_META[status] || { key: "ready" }).key;
  return {
    bg: `var(--st-${k}-bg)`,
    fg: `var(--st-${k}-fg)`,
    dot: `var(--st-${k}-dot)`,
  };
}

function StatusPill({ status, dotOnly, solid }) {
  const v = statusVars(status);
  const label = (STATUS_META[status] || { label: status }).label;
  if (solid) {
    return (
      <span className="status-pill solid" style={{ background: v.fg, color: "#fff" }}>{label}</span>
    );
  }
  return (
    <span className="status-pill" style={{ background: v.bg, color: v.fg }}>
      <span className="dot" style={{ background: v.dot }}></span>
      {!dotOnly && label}
    </span>
  );
}

/* markdown-style checkbox glyph reflecting status (shared by Graph / Board / Table) */
function StatusGlyph({ status, color, size }) {
  const s = size || 18;
  const common = { width: s, height: s, viewBox: "0 0 24 24", fill: "none" };
  const box = <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke={color} strokeWidth="2" />;
  if (status === "done") {
    return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="5" fill={color} /><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (status === "blocked") {
    return <svg {...common}>{box}<path d="M8 8l8 8" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>;
  }
  if (status === "in progress") {
    return <svg {...common}>{box}<path d="M3.5 12a8.5 8.5 0 008.5 8.5V3.5A8.5 8.5 0 003.5 12z" fill={color} opacity="0.9" /></svg>;
  }
  if (status === "in review") {
    return <svg {...common}>{box}<circle cx="12" cy="12" r="3.4" fill={color} /></svg>;
  }
  return <svg {...common}>{box}</svg>; // ready = empty
}

/* glyph + label — the board/table status treatment, matching the graph checklist language */
function StatusTag({ status, glyphSize }) {
  const v = statusVars(status);
  const label = (STATUS_META[status] || { label: status }).label;
  return (
    <span className="status-tag" style={{ color: v.fg }}>
      <StatusGlyph status={status} color={v.dot} size={glyphSize || 16} />
      <span className="status-tag-label">{label}</span>
    </span>
  );
}

/* Status distribution bar — proportional segments per status across a set of stories.
   Shared by the graph epic cards, board epic headers, and table epic rows. */
function StatusDistribution({ stories }) {
  const counts = {};
  window.LOOM.STATUSES.forEach((s) => (counts[s] = 0));
  (stories || []).forEach((s) => { if (counts[s.status] != null) counts[s.status]++; });
  const total = (stories || []).length;
  return (
    <span className="dist-bar" title="Status distribution">
      {total === 0
        ? <span className="dist-empty"></span>
        : window.LOOM.STATUSES.map((s) =>
            counts[s] > 0
              ? <span key={s} className="dist-seg" style={{ flexGrow: counts[s], background: statusVars(s).dot }} title={`${counts[s]} ${(STATUS_META[s] || { label: s }).label}`}></span>
              : null)}
    </span>
  );
}

function epicSummary(stories) {
  const ss = stories || [];
  return {
    total: ss.length,
    done: ss.filter((s) => s.status === "done").length,
    blocked: ss.filter((s) => s.status === "blocked").length,
  };
}

/* Epic display status: review gate overrides the story rollup.
   active -> roll up from stories; in review / done -> explicit. */
function epicDisplayStatus(epic) {
  const r = epic.review || "active";
  if (r === "done") return "done";
  if (r === "in review") return "in review";
  const ss = (epic.stories || []).map((s) => s.status);
  if (!ss.length) return "ready";
  if (ss.every((s) => s === "done")) return "done";
  if (ss.some((s) => s === "blocked")) return "blocked";
  if (ss.some((s) => s === "in progress")) return "in progress";
  return "ready";
}

/* Task progress meter — neutral ticks + count. Shared by graph nodes, board cards, table rows. */
function TaskMeter({ tasks }) {
  if (!tasks || !tasks.length) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <span className="task-meter" title={`${done}/${tasks.length} tasks done`}>
      <span className="tm-ticks">
        {tasks.map((t, i) => <span key={i} className="tm-tick" style={{ background: t.status === "done" ? "var(--text-2)" : "var(--border-strong)" }}></span>)}
      </span>
      <span className="tm-count mono">{done}/{tasks.length}</span>
    </span>
  );
}

/* Tag color palette — fixed soft pastels keyed by tag name (saturation nudged by --tag-sat). */
const TAG_HUES = {
  backend: 212, frontend: 280, design: 332, auth: 38,
  payments: 152, data: 195, infra: 45, mobile: 222, security: 0,
};
function tagStyle(tag) {
  const hue = TAG_HUES[tag] != null ? TAG_HUES[tag] : 250;
  return {
    background: `oklch(var(--tag-bg-l, 0.95) calc(var(--tag-bg-c, 0.055) * var(--tag-sat)) ${hue})`,
    color: `oklch(var(--tag-fg-l, 0.46) calc(var(--tag-fg-c, 0.09) * var(--tag-sat)) ${hue})`,
  };
}
function TagChip({ tag }) {
  return <span className="tag-chip" style={tagStyle(tag)}>{tag}</span>;
}

/* Fully-qualified loom id, hashtag-prefixed: #project:epic:story[:task] */
function qid(...parts) {
  return "#" + parts.filter((x) => x != null && x !== "").join(":");
}

/* AI agent session badge — rounded chip (not a person avatar). Icon variant is
   global (set from the Tweaks panel); per-session hue keeps them distinguishable. */
const AGENT_ICONS = {
  bot: (c) => <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="7.5" width="16" height="11.5" rx="3.4" stroke={c} strokeWidth="1.8"/><path d="M12 3.4V7.5" stroke={c} strokeWidth="1.8" strokeLinecap="round"/><circle cx="12" cy="3" r="1.5" fill={c}/><circle cx="9.2" cy="13" r="1.45" fill={c}/><circle cx="14.8" cy="13" r="1.45" fill={c}/></svg>,
  spark: (c) => <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5c.7 5.3 3.5 8.1 8.8 8.8-5.3.7-8.1 3.5-8.8 8.8-.7-5.3-3.5-8.1-8.8-8.8C8.5 10.6 11.3 7.8 12 2.5z" fill={c}/></svg>,
  hex: (c) => <svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3z" stroke={c} strokeWidth="1.7" strokeLinejoin="round"/><circle cx="12" cy="12" r="2.6" fill={c}/></svg>,
  terminal: (c) => <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4.5" width="18" height="15" rx="3" stroke={c} strokeWidth="1.7"/><path d="M7.5 10l3 2.2-3 2.2M12.8 15h4" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

function AgentBadge({ who, size }) {
  const p = window.LOOM.PEOPLE[who];
  if (!p) return null;
  const s = size || 22;
  const variant = window.LOOM_AGENT_ICON || "terminal";
  const draw = AGENT_ICONS[variant] || AGENT_ICONS.terminal;
  return (
    <span className="agent-badge" title={p.session} style={{ width: s, height: s }}>
      {draw("currentColor")}
    </span>
  );
}

/* tiny inline icons (stroke = currentColor) */
const Icon = {
  chevDown: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  chevRight: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" {...p}><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  chevLeft: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" {...p}><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  check: (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" {...p}><path d="M5 12l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  board: (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" {...p}><rect x="3" y="4" width="5" height="16" rx="1.4" stroke="currentColor" strokeWidth="1.8"/><rect x="10" y="4" width="5" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.8"/><rect x="17" y="4" width="4" height="14" rx="1.4" stroke="currentColor" strokeWidth="1.8"/></svg>,
  table: (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" {...p}><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8"/><path d="M3 9.5h18M3 15h18M9 4.5v15" stroke="currentColor" strokeWidth="1.5"/></svg>,
  graph: (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" {...p}><circle cx="5" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.8"/><circle cx="14" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8"/><circle cx="14" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.8"/><circle cx="20.5" cy="12" r="1.6" fill="currentColor"/><path d="M7.2 10.8L12 7.4M7.2 13.2L12 16.6" stroke="currentColor" strokeWidth="1.6"/></svg>,
  link: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 10-5.66-5.66L11.5 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 105.66 5.66L12.5 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>,
  github: (p) => <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" {...p}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>,
  search: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" {...p}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>,
  x: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>,
  block: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8"/><path d="M6.2 6.2l11.6 11.6" stroke="currentColor" strokeWidth="1.8"/></svg>,
  dep: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M4 12h13M12 7l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  hash: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" {...p}><path d="M10 4.2L8 19.8M16 4.2L14 19.8M4.8 9H19.6M4.4 15H19.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>,
  review: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" {...p}><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.9"/><path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/><path d="M8 10.5l1.8 1.8L13.5 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  accepted: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" {...p}><path d="M12 2.5l2.4 1.7 2.9-.2 1 2.7 2.4 1.6-.7 2.9.7 2.9-2.4 1.6-1 2.7-2.9-.2L12 21.5l-2.4-1.7-2.9.2-1-2.7L3.3 15.7l.7-2.9-.7-2.9 2.4-1.6 1-2.7 2.9.2L12 2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M8.5 12l2.3 2.3L15.5 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

/* qid chip: stylized hashtag glyph + the fully-qualified id (no literal '#') */
function Qid({ id, className }) {
  return (
    <span className={"qid" + (className ? " " + className : "")}>
      <span className="qid-hash"><Icon.hash /></span>
      <span className="qid-text mono">{id}</span>
    </span>
  );
}

/* epic accent -> color (rail / dot) */
const EPIC_ACCENT = {
  violet: "oklch(0.72 0.12 295)",
  amber:  "oklch(0.78 0.12 75)",
  blue:   "oklch(0.72 0.11 235)",
  slate:  "oklch(0.72 0.02 250)",
  green:  "oklch(0.74 0.10 155)",
};
function epicColor(accent) { return EPIC_ACCENT[accent] || EPIC_ACCENT.slate; }

Object.assign(window, {
  STATUS_META, statusVars, StatusPill, StatusGlyph, StatusTag, StatusDistribution, epicSummary, epicDisplayStatus, TaskMeter, TagChip, AgentBadge, AGENT_ICONS, qid, Qid, Icon, epicColor, tagStyle,
});
