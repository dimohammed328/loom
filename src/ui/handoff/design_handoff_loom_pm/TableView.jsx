/* Loom PM — Table view
 * Multi-index collapsible tree: epic ▸ story ▸ task.
 * Columns: Name · Status (solid pill, all levels) · Updated.
 * Controlled collapse state lives in App (so Expand/Collapse-all can drive it). */

// Roll a parent's status up from its children.
function rollupStatus(statuses) {
  if (!statuses.length) return "ready";
  if (statuses.every((s) => s === "done")) return "done";
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.some((s) => s === "in progress")) return "in progress";
  if (statuses.some((s) => s === "in review")) return "in review";
  return "ready";
}

function TitleCell({ level, hasChildren, collapsed, onToggle, qid, title, onOpen }) {
  return (
    <div className={"tcell-title " + (level === 1 ? "indent-1" : level === 2 ? "indent-2" : "")}>
      <span
        className={"tw-chev" + (hasChildren ? "" : " leaf") + (collapsed ? " collapsed" : "")}
        onClick={hasChildren ? onToggle : undefined}
      >
        <Icon.chevDown />
      </span>
      <span className="tw-ttext tw-open" onClick={() => onOpen && onOpen(qid)}>{title}</span>
      <Qid id={qid} className="tw-id" />
    </div>
  );
}

function MetaCells({ item, tasks }) {
  return (
    <React.Fragment>
      <td>{tasks && tasks.length > 0 ? <TaskMeter tasks={tasks} /> : <span className="tcell-none">—</span>}</td>
      <td><StatusTag status={item.status} /></td>
      <td><span className="tcell-upd">{item.updated || "—"}</span></td>
    </React.Fragment>
  );
}

function TableView({ project, collapsed, onToggle, onOpen }) {
  const pid = project.id;
  const rows = [];

  project.epics.forEach((epic) => {
    const eqid = `${pid}:${epic.id}`;
    const eCollapsed = !!collapsed[eqid];
    const sum = epicSummary(epic.stories);
    const epicUpdated = epic.stories.reduce((a, s) => s.updated || a, "—");
    rows.push(
      <tr className="row-epic" key={eqid}>
        <td>
          <TitleCell
            level={0} hasChildren={epic.stories.length > 0}
            collapsed={eCollapsed} onToggle={() => onToggle(eqid)}
            qid={eqid} title={epic.title} onOpen={onOpen}
          />
        </td>
        <td>
          <span className="tcell-dist">
            <StatusDistribution stories={epic.stories} />
            <span className="tcell-prog"><strong>{sum.done}/{sum.total}</strong>{sum.blocked > 0 ? ` · ${sum.blocked} blocked` : ""}</span>
          </span>
        </td>
        <td><StatusTag status={epicDisplayStatus(epic)} /></td>
        <td><span className="tcell-upd">{epicUpdated}</span></td>
      </tr>
    );
    if (eCollapsed) return;

    epic.stories.forEach((story) => {
      const sqid = `${eqid}:${story.id}`;
      const sCollapsed = !!collapsed[sqid];
      const hasTasks = story.tasks && story.tasks.length > 0;
      rows.push(
        <tr className="row-story" key={sqid}>
          <td>
            <TitleCell
              level={1} hasChildren={hasTasks}
              collapsed={sCollapsed} onToggle={() => onToggle(sqid)}
              qid={sqid} title={story.title} onOpen={onOpen}
            />
          </td>
          <MetaCells item={story} tasks={story.tasks} />
        </tr>
      );
      if (sCollapsed || !hasTasks) return;
      story.tasks.forEach((task) => {
        const tqid = `${sqid}:${task.id}`;
        rows.push(
          <tr className="row-task" key={tqid}>
            <td>
              <TitleCell
                level={2} hasChildren={false}
                qid={tqid} title={task.title} onOpen={onOpen}
              />
            </td>
            <MetaCells item={task} />
          </tr>
        );
      });
    });
  });

  return (
    <div className="view-scroll">
      <div className="tablewrap">
        <table className="ttable">
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Name</th>
              <th style={{ width: "22%" }}>Progress</th>
              <th style={{ width: "20%" }}>Status</th>
              <th style={{ width: "18%" }}>Updated</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </div>
  );
}

window.TableView = TableView;
