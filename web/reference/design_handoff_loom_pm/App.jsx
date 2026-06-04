/* Loom PM — App shell: top bar (project switcher) + view tabs + state */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "notion",
  "accent": "soft",
  "density": "airy",
  "font": "default",
  "nodeStyle": "checklist",
  "agentIcon": "terminal",
  "epicReview": "banner"
} /*EDITMODE-END*/;

// Professional but distinctive typefaces. "default" defers to the theme's own pairing.
const FONT_STACKS = {
  schibsted: '"Schibsted Grotesk", system-ui, sans-serif',
  bricolage: '"Bricolage Grotesque", system-ui, sans-serif',
  instrument: '"Instrument Sans", system-ui, sans-serif',
  plex: '"IBM Plex Sans", system-ui, sans-serif',
  space: '"Space Grotesk", system-ui, sans-serif'
};
const FONT_OPTIONS = [
{ value: "default", label: "Theme default" },
{ value: "schibsted", label: "Schibsted Grotesk" },
{ value: "bricolage", label: "Bricolage Grotesque" },
{ value: "instrument", label: "Instrument Sans" },
{ value: "plex", label: "IBM Plex Sans" },
{ value: "space", label: "Space Grotesk" }];


function useOutsideClose(open, onClose) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    function onDown(e) {if (ref.current && !ref.current.contains(e.target)) onClose();}
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return ref;
}

function clone(x) {return JSON.parse(JSON.stringify(x));}

function allStoryQids(project) {
  const out = [];
  project.epics.forEach((e) => e.stories.forEach((s) => out.push(`${project.id}:${e.id}:${s.id}`)));
  return out;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [projects, setProjects] = React.useState(() => clone(window.LOOM.PROJECTS));
  const [currentId, setCurrentId] = React.useState(projects[0].id);
  const [view, setView] = React.useState("board");
  const [projMenu, setProjMenu] = React.useState(false);
  const [openQid, setOpenQid] = React.useState(null);

  // agent session icon variant is read globally by AgentBadge during render
  window.LOOM_AGENT_ICON = t.agentIcon;

  const project = projects.find((p) => p.id === currentId);

  const [dagEpicId, setDagEpicId] = React.useState(project.epics[0].id);
  const [collapsed, setCollapsed] = React.useState({});

  // apply theme tweaks to <html>
  React.useEffect(() => {
    const r = document.documentElement;
    r.setAttribute("data-theme", t.theme);
    r.setAttribute("data-accent", t.accent);
    r.setAttribute("data-density", t.density);
  }, [t.theme, t.accent, t.density]);

  // typeface override (defers to theme pairing when "default")
  React.useEffect(() => {
    const r = document.documentElement;
    if (t.font && t.font !== "default" && FONT_STACKS[t.font]) {
      r.style.setProperty("--font-body", FONT_STACKS[t.font]);
      r.style.setProperty("--font-head", FONT_STACKS[t.font]);
    } else {
      r.style.removeProperty("--font-body");
      r.style.removeProperty("--font-head");
    }
  }, [t.font, t.theme]);

  // on project change: reset dag epic + collapse defaults (stories collapsed → tasks hidden)
  React.useEffect(() => {
    setDagEpicId(project.epics[0].id);
    const init = {};
    allStoryQids(project).forEach((q) => init[q] = true);
    setCollapsed(init);
  }, [currentId]);

  const dagEpic = project.epics.find((e) => e.id === dagEpicId) || project.epics[0];

  const projRef = useOutsideClose(projMenu, () => setProjMenu(false));

  function moveStory(fromEpicId, storyId, toEpicId, toStatus) {
    setProjects((prev) => {
      const next = clone(prev);
      const proj = next.find((p) => p.id === currentId);
      const fromEpic = proj.epics.find((e) => e.id === fromEpicId);
      const idx = fromEpic.stories.findIndex((s) => s.id === storyId);
      if (idx < 0) return prev;
      const [story] = fromEpic.stories.splice(idx, 1);
      story.status = toStatus;
      const toEpic = proj.epics.find((e) => e.id === toEpicId);
      toEpic.stories.push(story);
      return next;
    });
  }

  function toggleRow(qid) {
    setCollapsed((c) => ({ ...c, [qid]: !c[qid] }));
  }
  function setAllCollapsed(val) {
    const m = {};
    project.epics.forEach((e) => {
      m[`${project.id}:${e.id}`] = val; // epics
      e.stories.forEach((s) => m[`${project.id}:${e.id}:${s.id}`] = val); // stories
    });
    setCollapsed(val ? m : {});
  }

  return (
    <div className="app">
      {/* ---------- TOP BAR ---------- */}
      <div className="topbar">
        <div className="proj-switch" ref={projRef}>
          <button className="bare proj-trigger" onClick={() => setProjMenu((o) => !o)}
            aria-haspopup="menu" aria-expanded={projMenu} title="Switch project">
            <span className="picon" aria-hidden="true">{project.icon}</span>
            <span className="pname">{project.title}</span>
            <span className="chev"><Icon.chevDown /></span>
          </button>
          {projMenu &&
          <div className="proj-menu" role="menu" aria-label="Projects">
              <div className="mlabel">Projects</div>
              {projects.map((p) =>
            <button className="bare proj-item" key={p.id}
            role="menuitemradio" aria-checked={p.id === currentId}
            onClick={() => {setCurrentId(p.id);setProjMenu(false);setView("board");}}>
                  <span className="picon" aria-hidden="true">{p.icon}</span>
                  <span className="pmeta">
                    <span className="t">{p.title}</span>
                    <span className="s">{p.subtitle}</span>
                  </span>
                  {p.id === currentId && <span className="check"><Icon.check /></span>}
                </button>
            )}
            </div>
          }
        </div>

        <span className="hdivider"></span>

        <div className="vtabs">
          <button className={"bare vtab" + (view === "board" ? " active" : "")} onClick={() => setView("board")} aria-current={view === "board" ? "page" : undefined}>
            <Icon.board /> Board
          </button>
          <button className={"bare vtab" + (view === "table" ? " active" : "")} onClick={() => setView("table")} aria-current={view === "table" ? "page" : undefined}>
            <Icon.table /> Table
          </button>
          <button className={"bare vtab" + (view === "graph" ? " active" : "")} onClick={() => setView("graph")} aria-current={view === "graph" ? "page" : undefined}>
            <Icon.graph /> Graph
          </button>
        </div>

        <span className="spacer"></span>

        {view === "table" &&
        <span style={{ display: "inline-flex", gap: 6 }}>
            <button className="bare ctl" onClick={() => setAllCollapsed(false)}>Expand all</button>
            <button className="bare ctl" onClick={() => setAllCollapsed(true)}>Collapse all</button>
          </span>
        }

        <span className="hdivider"></span>
        <a className="repo" href={"https://" + project.repo} target="_blank" rel="noreferrer">
          <Icon.github /> {project.repo.replace("github.com/", "")}
        </a>
      </div>

      {/* ---------- ACTIVE VIEW ---------- */}
      {view === "board" && <KanbanView project={project} onMoveStory={moveStory} onOpen={setOpenQid} />}
      {view === "table" && <TableView project={project} collapsed={collapsed} onToggle={toggleRow} onOpen={setOpenQid} />}
      {view === "graph" && <DagView project={project} epic={dagEpic} epics={project.epics} dagEpicId={dagEpicId} setDagEpicId={setDagEpicId} nodeStyle={t.nodeStyle} onOpen={setOpenQid} />}

      <ItemModal qs={openQid} onClose={() => setOpenQid(null)} onOpen={setOpenQid} reviewStyle={t.epicReview} />

      {/* ---------- TWEAKS ---------- */}
      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Palette" value={t.theme}
        options={["notion", "slate", "editorial", "linear"]}
        onChange={(v) => setTweak("theme", v)} />
        <TweakRadio label="Accent" value={t.accent}
        options={["soft", "vivid"]}
        onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density}
        options={["airy", "compact"]}
        onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Typeface" />
        <TweakSelect label="Font" value={t.font}
        options={FONT_OPTIONS}
        onChange={(v) => setTweak("font", v)} />
        <TweakSection label="Graph" />
        <TweakRadio label="Node style" value={t.nodeStyle}
        options={["ports", "checklist", "spine"]}
        onChange={(v) => setTweak("nodeStyle", v)} />
        <TweakSection label="Agents" />
        <TweakRadio label="Session icon" value={t.agentIcon}
        options={["bot", "spark", "hex", "terminal"]}
        onChange={(v) => setTweak("agentIcon", v)} />
        <TweakSection label="Epic review" />
        <TweakRadio label="Concept" value={t.epicReview}
        options={["banner", "stepper", "split"]}
        onChange={(v) => setTweak("epicReview", v)} />
      </TweaksPanel>
    </div>);

}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);