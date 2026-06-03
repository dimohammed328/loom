/* Loom PM — Kanban (Board) view — MATRIX layout
 * Rows = epics (sticky left row-headers), columns = statuses (sticky top headers).
 * Cells hold story cards. Drag a card to another cell to change status / epic. */

function KanbanCard({ pid, epic, story, dragging, onDragStart, onDragEnd, onOpen }) {
  const blocked = story.status === "blocked";
  const depCount = (story.depends_on || []).length;
  const sqid = pid + ":" + epic.id + ":" + story.id;
  return (
    <div
      className={"kcard" + (dragging ? " dragging" : "")}
      draggable
      onDragStart={(e) => onDragStart(e, epic.id, story.id)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen && onOpen(sqid)}
    >
      <div className="ktop">
        <div className="ktitle">{story.title}</div>
      </div>
      {story.tags && story.tags.length > 0 && (
        <div className="ktags">
          {story.tags.map((t) => <TagChip key={t} tag={t} />)}
        </div>
      )}
      <div className="kbottom">
        <div className="kfoot">
          <Qid id={sqid} className="kid" />
          {blocked
            ? <span className="kblock"><Icon.block /> blocked</span>
            : depCount > 0
              ? <span className="kdep"><Icon.dep /> {depCount} dep{depCount > 1 ? "s" : ""}</span>
              : null}
        </div>
        {story.tasks && story.tasks.length > 0 && <TaskMeter tasks={story.tasks} />}
      </div>
    </div>
  );
}

function EpicRowHead({ pid, epic, collapsed, onToggle, onOpen }) {
  const sum = epicSummary(epic.stories);
  const review = epic.review || "active";
  return (
    <div className={"epic-rowhead" + (collapsed ? " collapsed" : "")} onClick={onToggle}>
      <div className="erh-top">
        <span className="erh-chev"><Icon.chevDown /></span>
        <span className="erh-title" onClick={(e) => { e.stopPropagation(); onOpen && onOpen(pid + ":" + epic.id); }}>{epic.title}</span>
      </div>
      <div className="erh-id"><Qid id={pid + ":" + epic.id} /></div>
      <StatusDistribution stories={epic.stories} />
      <div className="erh-meta">
        <strong>{sum.done}/{sum.total}</strong> complete
        {sum.blocked > 0 && <React.Fragment> <span className="erh-dot">·</span> <span className="erh-blocked">{sum.blocked} blocked</span></React.Fragment>}
      </div>
      {review === "in review" && <span className="erv-chip erv-c-inreview erh-rev"><Icon.review /> In review</span>}
      {review === "done" && <span className="erv-chip erv-c-done erh-rev"><Icon.accepted /> Accepted</span>}
    </div>
  );
}

function KanbanView({ project, onMoveStory, onOpen }) {
  const STATUSES = window.LOOM.STATUSES;
  const pid = project.id;
  const [collapsed, setCollapsed] = React.useState({});
  const [drag, setDrag] = React.useState(null);   // { epicId, storyId }
  const [over, setOver] = React.useState(null);    // "epicId|status"

  const gridCols = `var(--epic-col) repeat(${STATUSES.length}, minmax(244px, 1fr))`;

  // per-status totals across the project
  const totals = {};
  STATUSES.forEach((s) => (totals[s] = 0));
  project.epics.forEach((e) => e.stories.forEach((st) => {
    if (totals[st.status] != null) totals[st.status]++;
  }));

  function onDragStart(e, epicId, storyId) {
    setDrag({ epicId, storyId });
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", `${epicId}:${storyId}`); } catch (_) {}
  }
  function onDrop(epicId, status) {
    if (drag) onMoveStory(drag.epicId, drag.storyId, epicId, status);
    setDrag(null); setOver(null);
  }

  return (
    <div className="view-scroll">
      <div className="board-grid" style={{ gridTemplateColumns: gridCols }}>
        {/* ---- header row ---- */}
        <div className="board-corner">
          <span className="bc-label">Epics</span>
          <span className="bc-count">{project.epics.length}</span>
        </div>
        {STATUSES.map((s) => {
          const v = statusVars(s);
          return (
            <div className="colhead" key={s}>
              <span className="colhead-glyph"><StatusGlyph status={s} color={v.dot} size={17} /></span>
              <span className="colhead-label">{(window.STATUS_META[s] || { label: s }).label}</span>
              <span className="cnt">{totals[s]}</span>
            </div>
          );
        })}

        <div className="board-headgap"></div>

        {/* ---- epic rows ---- */}
        {project.epics.map((epic, ei) => {
          const isCollapsed = collapsed[epic.id];
          const byStatus = {};
          STATUSES.forEach((s) => (byStatus[s] = []));
          epic.stories.forEach((st) => {
            if (byStatus[st.status]) byStatus[st.status].push(st);
            else (byStatus[st.status] = [st]);
          });
          return (
            <React.Fragment key={epic.id}>
              {ei > 0 && <div className="epic-sep"></div>}
              <EpicRowHead
                pid={pid}
                epic={epic}
                collapsed={isCollapsed}
                onToggle={() => setCollapsed((c) => ({ ...c, [epic.id]: !c[epic.id] }))}
                onOpen={onOpen}
              />
              {isCollapsed
                ? <div className="row-collapsed" style={{ gridColumn: `span ${STATUSES.length}` }}>
                    {`${epic.stories.length} ${epic.stories.length === 1 ? "story" : "stories"} hidden`}
                  </div>
                : STATUSES.map((status) => {
                    const key = `${epic.id}|${status}`;
                    return (
                      <div
                        key={status}
                        className={"kcol" + (over === key ? " drop-target" : "")}
                        onDragOver={(e) => { e.preventDefault(); if (over !== key) setOver(key); }}
                        onDragLeave={() => { if (over === key) setOver(null); }}
                        onDrop={(e) => { e.preventDefault(); onDrop(epic.id, status); }}
                      >
                        {byStatus[status].map((st) => (
                          <KanbanCard
                            key={st.id}
                            pid={pid}
                            epic={epic}
                            story={st}
                            dragging={drag && drag.epicId === epic.id && drag.storyId === st.id}
                            onDragStart={onDragStart}
                            onDragEnd={() => { setDrag(null); setOver(null); }}
                            onOpen={onOpen}
                          />
                        ))}
                        <div className="empty">Drop here</div>
                      </div>
                    );
                  })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

window.KanbanView = KanbanView;
