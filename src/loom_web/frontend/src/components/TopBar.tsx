/**
 * TopBar — sticky 52px header.
 *
 * Contains:
 *  - Project switcher (dropdown populated from /api/projects)
 *  - Board / Table / Graph view tabs
 *  - Theme toggle (light ↔ dark, persisted via theme.ts)
 *  - Repo link (current project's repo URL)
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { listProjects, type ProjectSummary } from "../api/client";
import { useAppStore, type View } from "../state/store";
import { getTheme, setTheme } from "../theme";
import { repoLabel, repoHref } from "../repoUtils";

// ---------------------------------------------------------------------------
// Inline SVG icons (no external deps)
// ---------------------------------------------------------------------------


function IconCheck(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.5 7l3.5 3.5 5.5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBoard(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="1" y="1" width="5.5" height="13" rx="1.5" fill="currentColor" opacity=".35" />
      <rect x="8.5" y="1" width="5.5" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function IconTable(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="1" y="1" width="13" height="3" rx="1" fill="currentColor" />
      <rect x="1" y="6" width="13" height="2.5" rx="1" fill="currentColor" opacity=".4" />
      <rect x="1" y="10.5" width="13" height="2.5" rx="1" fill="currentColor" opacity=".4" />
    </svg>
  );
}

function IconGraph(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="3" cy="7.5" r="2" fill="currentColor" />
      <circle cx="12" cy="3" r="2" fill="currentColor" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M5 7.5h2.5M7.5 7.5L10 3M7.5 7.5L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconGithub(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function IconSun(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="7.5" cy="7.5" r="2.5" fill="currentColor" />
      <path d="M7.5 1v1.5M7.5 12.5V14M1 7.5h1.5M12.5 7.5H14M3.05 3.05l1.06 1.06M10.89 10.89l1.06 1.06M10.89 4.11l1.06-1.06M3.05 11.95l1.06-1.06" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconMoon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M12.5 9.5A6 6 0 015.5 2.5a6 6 0 100 10 6 6 0 007-3z" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Project switcher dropdown
// ---------------------------------------------------------------------------

interface ProjectMenuProps {
  projects: ProjectSummary[];
  current: ProjectSummary;
  onSelect: (p: ProjectSummary) => void;
  onClose: () => void;
}

function ProjectMenu({ projects, current, onSelect, onClose }: ProjectMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div className="proj-menu" ref={ref} role="menu">
      <div className="mlabel">Projects</div>
      {projects.map((p) => (
        <button
          key={p.qid}
          className="proj-item bare"
          role="menuitem"
          onClick={() => { onSelect(p); onClose(); }}
        >
          <span className="pmeta">
            <span className="t">{p.title}</span>
          </span>
          {p.qid === current.qid && (
            <span className="check"><IconCheck /></span>
          )}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

const TABS: { id: View; label: string; Icon: () => React.JSX.Element }[] = [
  { id: "board", label: "Board", Icon: IconBoard },
  { id: "table", label: "Table", Icon: IconTable },
  { id: "graph", label: "Graph", Icon: IconGraph },
];

export default function TopBar(): React.JSX.Element {
  const { projects, currentProject, view, collapseControl, setProjects, setCurrentProject, setView } = useAppStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => getTheme() === "dark");

  // Load projects on mount
  useEffect(() => {
    if (projects !== null) return;
    listProjects()
      .then(setProjects)
      .catch((err: unknown) => console.error("Failed to load projects:", err));
  }, [projects, setProjects]);

  const toggleMenu = useCallback(() => setMenuOpen((v) => !v), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleThemeToggle = useCallback(() => {
    const next = isDark ? "light" : "dark";
    setTheme(next);
    setIsDark(!isDark);
  }, [isDark]);

  const repoUrl = currentProject?.repo ?? null;
  const repoName = repoUrl ? repoLabel(repoUrl) : null;
  const repoLink = repoUrl ? repoHref(repoUrl) : null;

  return (
    <header className="topbar">
      {/* Project switcher */}
      <div className="proj-switch">
        <button
          className="proj-trigger bare"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
        >
          <span className="pname">{currentProject?.title ?? "No project"}</span>
        </button>

        {menuOpen && projects && currentProject && (
          <ProjectMenu
            projects={projects}
            current={currentProject}
            onSelect={setCurrentProject}
            onClose={closeMenu}
          />
        )}
      </div>

      {/* Divider */}
      <div className="hdivider" aria-hidden />

      {/* View tabs */}
      <nav className="vtabs" aria-label="Views">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`vtab bare${view === id ? " active" : ""}`}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>

      <div className="spacer" />

      {/* Expand/Collapse-all — visible only when table view is active */}
      {collapseControl && (
        <button
          className="ctl"
          onClick={collapseControl.toggle}
          title={collapseControl.isAllCollapsed ? "Expand all rows" : "Collapse all rows"}
          aria-label={collapseControl.isAllCollapsed ? "Expand all rows" : "Collapse all rows"}
        >
          {collapseControl.isAllCollapsed ? "Expand all" : "Collapse all"}
        </button>
      )}

      {/* Theme toggle */}
      <button
        className="theme-toggle bare"
        title={isDark ? "Switch to light theme" : "Switch to dark theme"}
        aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        onClick={handleThemeToggle}
      >
        {isDark ? <IconSun /> : <IconMoon />}
      </button>

      {/* Repo link */}
      {repoName && repoLink && (
        <a
          className="repo"
          href={repoLink}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open repository ${repoName}`}
        >
          <IconGithub />
          {repoName}
        </a>
      )}
    </header>
  );
}
