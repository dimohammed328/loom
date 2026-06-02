/* Loom PM — DAG (Graph) view
 * Scoped to ONE epic. Nodes = stories, edges = depends_on (within the epic).
 * Layered left→right layout (layer = longest dependency path).
 * Epic selection lives in a collapsible right-side drawer. */

const NODE_W = 218,GAP_X = 92,GAP_Y = 30,PAD = 56;
// Fixed per-style heights (the layout math + edge endpoints depend on them).
// Sized to fit a two-line title; titles are clamped to two lines in CSS so
// content can never exceed the box.
const NODE_HEIGHTS = { ports: 124, checklist: 128, spine: 86 };

function computeLayout(project, epic, NODE_H) {
  const pid = project.id;
  const stories = epic.stories;
  const inEpic = new Set(stories.map((s) => `${pid}:${epic.id}:${s.id}`));
  const byQid = {};
  stories.forEach((s) => byQid[`${pid}:${epic.id}:${s.id}`] = s);

  const deps = {};
  stories.forEach((s) => {
    const q = `${pid}:${epic.id}:${s.id}`;
    deps[q] = (s.depends_on || []).filter((d) => inEpic.has(d));
  });

  const layerOf = {};
  function layer(q, seen) {
    if (layerOf[q] != null) return layerOf[q];
    seen = seen || new Set();
    if (seen.has(q)) return 0;
    seen.add(q);
    const ds = deps[q];
    let L = 0;
    if (ds.length) L = 1 + Math.max(...ds.map((d) => layer(d, seen)));
    layerOf[q] = L;
    return L;
  }
  Object.keys(deps).forEach((q) => layer(q));

  const layers = {};
  Object.keys(layerOf).forEach((q) => {
    (layers[layerOf[q]] = layers[layerOf[q]] || []).push(q);
  });
  const layerIdxs = Object.keys(layers).map(Number).sort((a, b) => a - b);

  const colHeights = layerIdxs.map((li) => {
    const n = layers[li].length;
    return n * NODE_H + (n - 1) * GAP_Y;
  });
  const maxH = Math.max(...colHeights, NODE_H);

  const pos = {};
  layerIdxs.forEach((li, ci) => {
    const col = layers[li];
    const colH = col.length * NODE_H + (col.length - 1) * GAP_Y;
    const yStart = PAD + (maxH - colH) / 2;
    col.forEach((q, ri) => {
      pos[q] = { x: PAD + ci * (NODE_W + GAP_X), y: yStart + ri * (NODE_H + GAP_Y), h: NODE_H, layer: li };
    });
  });

  const edges = [];
  Object.keys(deps).forEach((q) => {deps[q].forEach((d) => edges.push({ from: d, to: q }));});

  // connection degrees (for ports)
  Object.keys(pos).forEach((q) => { pos[q].hasIn = (deps[q] || []).length > 0; pos[q].hasOut = false; });
  edges.forEach((e) => { if (pos[e.from]) pos[e.from].hasOut = true; });

  const width = PAD * 2 + layerIdxs.length * NODE_W + (layerIdxs.length - 1) * GAP_X;
  const height = PAD * 2 + maxH;

  return { pos, edges, byQid, width, height, layerIdxs, stages: layerIdxs.length };
}

// markdown-style checkbox glyph reflecting status — shared via window (see shared.jsx)
const StatusGlyph = window.StatusGlyph;

function DagNode({ story, p, nodeStyle, nodeQid, onOpen }) {
  const v = statusVars(story.status);
  const label = (window.STATUS_META[story.status] || { label: story.status }).label;
  const base = "dag-node ns-" + nodeStyle + (story.status === "done" ? " is-done" : "");
  const style = { left: p.x, top: p.y, height: p.h, "--rail": v.dot, "--stbg": v.bg, "--stfg": v.fg, "--stdot": v.dot };
  const tasks = story.tasks || [];
  const doneT = tasks.filter((t) => t.status === "done").length;
  const open = onOpen ? () => onOpen(nodeQid) : undefined;
  const sess = window.LOOM.PEOPLE[story.assignee];

  if (nodeStyle === "checklist") {
    return (
      <div className={base} style={{ ...style, borderColor: v.dot, boxShadow: `0 1px 2px ${v.bg}` }} onClick={open}>
        <div className="ncl-row">
          <span className="ncl-ic"><StatusGlyph status={story.status} color={v.dot} size={18} /></span>
          <div className="ntitle">{story.title}</div>
        </div>
        {sess &&
          <div className="ncl-row">
            <span className="ncl-ic"><AgentBadge who={story.assignee} size={18} /></span>
            <span className="ncl-sess mono">{sess.session}</span>
          </div>}
        <div className="ncl-bottom">
          <Qid id={nodeQid} className="ncl-id" />
          <TaskMeter tasks={tasks} />
        </div>
      </div>);
  }

  if (nodeStyle === "spine") {
    return (
      <div className={base} style={style} onClick={open}>
        <span className="nsp-ring" style={{ borderColor: v.dot }}>
          <span className="nsp-core" style={{ background: v.dot }}></span>
        </span>
        <div className="nsp-body">
          <div className="ntitle">{story.title}</div>
          <div className="nsp-meta">
            <span style={{ color: v.fg, fontWeight: 600 }}>{label}</span>
            <span className="nsp-sep">·</span>
            <Qid id={nodeQid} className="nid" />
          </div>
        </div>
      </div>);
  }

  // default: ports — node-editor style with docking connectors
  return (
    <div className={base} style={style} onClick={open}>
      {p.hasIn && <span className="nport nport-in" style={{ borderColor: v.dot }}></span>}
      {p.hasOut && <span className="nport nport-out"></span>}
      <div className="npt-head">
        <span className="status-pill" style={{ background: v.bg, color: v.fg }}>
          <span className="dot" style={{ background: v.dot }}></span>{label}
        </span>
        <Qid id={nodeQid} className="nid" />
      </div>
      <div className="ntitle">{story.title}</div>
      <div className="npt-foot">
        <span className="npt-dep">
          {p.hasIn ? <React.Fragment><Icon.dep /> {(story.depends_on || []).length} upstream</React.Fragment> : "no dependencies"}
        </span>
        {tasks.length > 0 && <span className="npt-tasks">{doneT}/{tasks.length} tasks</span>}
      </div>
    </div>);
}

function EpicDrawer({ epics, dagEpicId, setDagEpicId, pid }) {
  const [open, setOpen] = React.useState(true);
  const [q, setQ] = React.useState("");

  const filtered = epics.filter((e) =>
  e.title.toLowerCase().includes(q.toLowerCase()) || e.id.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className={"dag-drawer" + (open ? "" : " collapsed")}>
      {open ?
      <div className="dd-top">
          <div className="dd-search">
            <span className="dd-search-ic"><Icon.search /></span>
            <input
            className="dd-search-input"
            placeholder="Search epics…"
            value={q}
            onChange={(e) => setQ(e.target.value)} />

            {q && <button className="bare dd-search-clear" onClick={() => setQ("")} aria-label="Clear search"><Icon.x /></button>}
          </div>
          <button className="bare dd-toggle" onClick={() => setOpen((o) => !o)} title="Collapse" aria-label="Collapse epics panel">
            <Icon.chevRight />
          </button>
        </div> :
      <div className="dd-bar">
          <button className="bare dd-toggle" onClick={() => setOpen((o) => !o)} title="Epics" aria-label="Expand epics panel">
            <Icon.chevLeft />
          </button>
          <span className="dd-title-v">Epics</span>
        </div>
      }

      {open &&
      <React.Fragment>
          <div className="dd-list">
            {filtered.length === 0 && <div className="dd-noresult">No epics match “{q}”.</div>}
            {filtered.map((e) => {
            const sum = epicSummary(e.stories);
            return (
              <button
                key={e.id}
                className={"bare dd-card" + (e.id === dagEpicId ? " active" : "")}
                onClick={() => setDagEpicId(e.id)}>
                  <div className="dd-card-top">
                    <span className="dd-card-name">{e.title}</span>
                  </div>
                  <div className="dd-card-id"><Qid id={pid + ":" + e.id} /></div>
                  <StatusDistribution stories={e.stories} />
                  <div className="dd-card-meta">
                    <span><strong>{sum.done}/{sum.total}</strong> complete</span>
                    {sum.blocked > 0 && <React.Fragment><span className="dot-sep">·</span><span className="dd-blocked">{sum.blocked} blocked</span></React.Fragment>}
                  </div>
                </button>);

          })}
          </div>
        </React.Fragment>
      }
    </div>);

}

function DagView({ project, epic, epics, dagEpicId, setDagEpicId, nodeStyle, onOpen }) {
  const NODE_H = NODE_HEIGHTS[nodeStyle] || NODE_HEIGHTS.ports;
  const L = React.useMemo(() => epic && epic.stories.length ? computeLayout(project, epic, NODE_H) : null, [project, epic, NODE_H]);

  function edgePath(e) {
    const a = L.pos[e.from],b = L.pos[e.to];
    if (!a || !b) return null;
    const x1 = a.x + NODE_W,y1 = a.y + NODE_H / 2;
    const x2 = b.x,y2 = b.y + NODE_H / 2;
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 7} ${y2}`;
  }

  return (
    <div className="dag-root">
      <div className="dag-scrollarea">
        {!L ?
        <div className="empty-state">This epic has no stories to graph.</div> :

        <div className="dag-canvas" style={{ width: L.width, height: L.height }}>
              <svg className="dag-svg" width={L.width} height={L.height}>
                <defs>
                  <marker id="dag-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
                    <path d="M1 1 L8 4.5 L1 8" fill="none" stroke="var(--border-strong)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </marker>
                </defs>
                {L.edges.map((e, i) => {
              const dpath = edgePath(e);
              return dpath ? <path key={i} className="dag-edge" d={dpath} markerEnd="url(#dag-arrow)" /> : null;
            })}
              </svg>
              {Object.keys(L.byQid).map((nq) => {
            const p = L.pos[nq];
            return p ? <DagNode key={nq} story={L.byQid[nq]} p={p} nodeStyle={nodeStyle} nodeQid={nq} onOpen={onOpen} /> : null;
          })}
            </div>
        }
      </div>
      <EpicDrawer epics={epics} dagEpicId={dagEpicId} setDagEpicId={setDagEpicId} pid={project.id} />
    </div>);

}

window.DagView = DagView;