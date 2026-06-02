/* Loom PM — unified detail modal for epics / stories / tasks.
 * Opened with a fully-qualified id string "project:epic[:story[:task]]".
 * Same shell for every level; sections render conditionally. */

function resolveItem(qs) {
  if (!qs) return null;
  const [pid, eid, sid, tid] = qs.split(":");
  const project = window.LOOM.PROJECTS.find((p) => p.id === pid);
  if (!project) return null;
  const epic = project.epics.find((e) => e.id === eid);
  if (!epic) return null;
  if (sid == null) return { level: "epic", project, epic, item: epic, qid: `${pid}:${eid}` };
  const story = epic.stories.find((s) => String(s.id) === String(sid));
  if (!story) return null;
  if (tid == null) return { level: "story", project, epic, story, item: story, qid: `${pid}:${eid}:${sid}` };
  const task = (story.tasks || []).find((t) => String(t.id) === String(tid));
  if (!task) return null;
  return { level: "task", project, epic, story, task, item: task, qid: `${pid}:${eid}:${sid}:${tid}` };
}

const LEVEL_LABEL = { epic: "Epic", story: "Story", task: "Task" };

/* ---- Epic review concepts (switchable via Tweaks → Epic review) ---- */

// Concept 1 — review gate banner under the title
function EpicReviewBanner({ epic, sum }) {
  const r = epic.review || "active";
  const rv = epic.reviewer ? window.LOOM.PEOPLE[epic.reviewer] : null;
  if (r === "in review") {
    return (
      <div className="erv-banner erv-inreview">
        <span className="erv-pulse"></span>
        <div className="erv-main">
          <strong>In review</strong>
          <span className="erv-sub">{sum.done}/{sum.total} stories complete · awaiting sign-off</span>
        </div>
        {rv && <span className="erv-by"><AgentBadge who={epic.reviewer} size={18} /><span className="mono">{rv.session}</span></span>}
      </div>);
  }
  if (r === "done") {
    return (
      <div className="erv-banner erv-done">
        <span className="erv-ic"><Icon.accepted /></span>
        <div className="erv-main">
          <strong>Accepted</strong>
          <span className="erv-sub">reviewed &amp; signed off{epic.reviewDate ? " · " + epic.reviewDate : ""}</span>
        </div>
        {rv && <span className="erv-by"><AgentBadge who={epic.reviewer} size={18} /><span className="mono">{rv.session}</span></span>}
      </div>);
  }
  return null;
}

// Concept 2 — lifecycle stepper
function EpicLifecycle({ epic }) {
  const r = epic.review || "active";
  const idx = r === "done" ? 2 : r === "in review" ? 1 : 0;
  const stages = ["Active", "In Review", "Done"];
  return (
    <div className="erv-stepper">
      {stages.map((s, i) => (
        <React.Fragment key={s}>
          {i > 0 && <span className={"erv-line" + (i <= idx ? " on" : "")}></span>}
          <span className={"erv-stage" + (i < idx ? " done" : i === idx ? " cur" : "")}>
            <span className="erv-node">{i < idx ? <Icon.check /> : <span className="erv-node-dot"></span>}</span>
            <span className="erv-stage-l">{s}</span>
          </span>
        </React.Fragment>
      ))}
    </div>);
}

// Concept 3 — review as a meta field (its own chip + reviewer)
function EpicReviewField({ epic }) {
  const r = epic.review || "active";
  const rv = epic.reviewer ? window.LOOM.PEOPLE[epic.reviewer] : null;
  return (
    <div className="mm-item">
      <span className="mm-k">Review</span>
      {r === "done"
        ? <span className="erv-chip erv-c-done"><Icon.accepted /> Accepted</span>
        : r === "in review"
          ? <span className="erv-chip erv-c-inreview"><Icon.review /> In review</span>
          : <span className="erv-chip erv-c-active">Not yet</span>}
      {rv && (r === "in review" || r === "done") &&
        <span className="erv-field-by"><AgentBadge who={epic.reviewer} size={18} /><span className="mono">{rv.session}</span></span>}
    </div>
  );
}

/* one clickable reference row (child or dependency) */
function RefRow({ qs, onOpen }) {
  const r = resolveItem(qs);
  if (!r) return null;
  const v = statusVars(r.item.status);
  return (
    <button className="bare ref-row" onClick={() => onOpen(qs)}>
      <span className="ref-ic"><StatusGlyph status={r.item.status} color={v.dot} size={16} /></span>
      <span className="ref-title">{r.item.title}</span>
      <Qid id={qs} className="ref-id" />
    </button>
  );
}

function ItemModal({ qs, onClose, onOpen, reviewStyle }) {
  const rstyle = reviewStyle || "banner";
  React.useEffect(() => {
    if (!qs) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [qs]);

  if (!qs) return null;
  const res = resolveItem(qs);
  if (!res) return null;

  const { level, project, epic, story, task, item } = res;
  const body = window.LOOM.BODIES[qs];
  const sess = item.assignee ? window.LOOM.PEOPLE[item.assignee] : null;

  // children
  let children = [], childLabel = "";
  if (level === "epic") {
    children = epic.stories.map((s) => `${project.id}:${epic.id}:${s.id}`);
    childLabel = "Stories";
  } else if (level === "story") {
    children = (story.tasks || []).map((t) => `${project.id}:${epic.id}:${story.id}:${t.id}`);
    childLabel = "Tasks";
  }

  // dependencies (stories only)
  let upstream = [], downstream = [];
  if (level === "story") {
    upstream = (story.depends_on || []).slice();
    const selfQ = `${project.id}:${epic.id}:${story.id}`;
    epic.stories.forEach((s) => {
      if ((s.depends_on || []).includes(selfQ)) downstream.push(`${project.id}:${epic.id}:${s.id}`);
    });
  }

  // breadcrumb
  const crumbs = [project.title, epic.title];
  if (level === "story" || level === "task") crumbs.push(story.title);
  if (level === "task") crumbs.push(task.title);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {/* header */}
        <div className="modal-head">
          <div className="modal-head-l">
            <span className={"type-pill type-" + level}>{LEVEL_LABEL[level]}</span>
            <Qid id={qs} className="modal-qid" />
          </div>
          <button className="bare modal-x" onClick={onClose} aria-label="Close"><Icon.x /></button>
        </div>

        <div className="modal-body">
          {/* breadcrumb */}
          <div className="modal-crumb">
            {crumbs.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="mc-sep">/</span>}
                <span className={"mc-seg" + (i === crumbs.length - 1 ? " cur" : "")}>{c}</span>
              </React.Fragment>
            ))}
          </div>

          <h1 className="modal-title">{item.title}</h1>

          {level === "epic" && rstyle === "banner" && <EpicReviewBanner epic={epic} sum={epicSummary(epic.stories)} />}
          {level === "epic" && rstyle === "stepper" && <EpicLifecycle epic={epic} />}

          {/* meta strip */}
          <div className="modal-meta">
            <div className="mm-item">
              <span className="mm-k">Status</span>
              {level === "epic"
                ? <StatusTag status={rstyle === "split" ? epicDisplayStatus({ stories: epic.stories }) : epicDisplayStatus(epic)} />
                : <StatusTag status={item.status} />}
            </div>
            {level === "epic" && rstyle === "split" && <EpicReviewField epic={epic} />}
            <div className="mm-item">
              <span className="mm-k">Assignee</span>
              {sess
                ? <span className="mm-sess"><AgentBadge who={item.assignee} size={20} /><span className="mono">{sess.session}</span></span>
                : <span className="mm-empty">—</span>}
            </div>
            <div className="mm-item">
              <span className="mm-k">Updated</span>
              <span className="mm-val">{item.updated || "—"}</span>
            </div>
            {level === "epic" && (
              <div className="mm-item">
                <span className="mm-k">Progress</span>
                <span className="mm-val">{epic.stories.filter((s) => s.status === "done").length}/{epic.stories.length} done</span>
              </div>
            )}
            {item.tags && item.tags.length > 0 && (
              <div className="mm-item">
                <span className="mm-k">Tags</span>
                <span className="mm-tags">{item.tags.map((t) => <TagChip key={t} tag={t} />)}</span>
              </div>
            )}
          </div>

          {/* body */}
          <div className="modal-section">
            <div className="ms-label">Description</div>
            {body
              ? <p className="modal-prose">{body}</p>
              : <p className="modal-prose empty">No description yet.</p>}
          </div>

          {/* dependencies */}
          {(upstream.length > 0 || downstream.length > 0) && (
            <div className="modal-cols">
              {upstream.length > 0 && (
                <div className="modal-section">
                  <div className="ms-label"><Icon.dep /> Depends on <span className="ms-count">{upstream.length}</span></div>
                  <div className="ref-list">{upstream.map((q) => <RefRow key={q} qs={q} onOpen={onOpen} />)}</div>
                </div>
              )}
              {downstream.length > 0 && (
                <div className="modal-section">
                  <div className="ms-label">Blocks <span className="ms-count">{downstream.length}</span></div>
                  <div className="ref-list">{downstream.map((q) => <RefRow key={q} qs={q} onOpen={onOpen} />)}</div>
                </div>
              )}
            </div>
          )}

          {/* children */}
          {children.length > 0 && (
            <div className="modal-section">
              <div className="ms-label">{childLabel} <span className="ms-count">{children.length}</span></div>
              <div className="ref-list">{children.map((q) => <RefRow key={q} qs={q} onOpen={onOpen} />)}</div>
            </div>
          )}
          {level !== "task" && children.length === 0 && (
            <div className="modal-section">
              <div className="ms-label">{level === "epic" ? "Stories" : "Tasks"}</div>
              <p className="modal-prose empty">No {level === "epic" ? "stories" : "tasks"} yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

window.ItemModal = ItemModal;
