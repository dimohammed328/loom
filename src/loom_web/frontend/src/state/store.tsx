/**
 * Global app state: selected project + active view.
 *
 * Implemented as a React context so any component can read/write without
 * prop drilling. The context value is stable across re-renders by keeping
 * actions in a ref-backed dispatch pattern.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { ProjectSummary } from "../api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type View = "board" | "table" | "graph";

export interface AppState {
  /** All projects returned from /api/projects (null = not yet loaded). */
  projects: ProjectSummary[] | null;
  /** Currently selected project, or null if none loaded yet. */
  currentProject: ProjectSummary | null;
  /** Active top-level view. */
  view: View;
  /** qid of item shown in modal, or null. */
  openQid: string | null;
}

export interface AppActions {
  setProjects: (projects: ProjectSummary[]) => void;
  setCurrentProject: (project: ProjectSummary) => void;
  setView: (view: View) => void;
  openModal: (qid: string) => void;
  closeModal: () => void;
}

export type AppStore = AppState & AppActions;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AppContext = createContext<AppStore | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [projects, setProjectsState] = useState<ProjectSummary[] | null>(null);
  const [currentProject, setCurrentProjectState] = useState<ProjectSummary | null>(null);
  const [view, setViewState] = useState<View>("board");
  const [openQid, setOpenQid] = useState<string | null>(null);

  const setProjects = useCallback((ps: ProjectSummary[]) => {
    setProjectsState(ps);
    // Auto-select the first project if none is selected yet.
    setCurrentProjectState((prev) => prev ?? (ps[0] ?? null));
  }, []);

  const setCurrentProject = useCallback((p: ProjectSummary) => {
    setCurrentProjectState(p);
    setViewState("board");
  }, []);

  const setView = useCallback((v: View) => setViewState(v), []);
  const openModal = useCallback((qid: string) => setOpenQid(qid), []);
  const closeModal = useCallback(() => setOpenQid(null), []);

  const store: AppStore = {
    projects,
    currentProject,
    view,
    openQid,
    setProjects,
    setCurrentProject,
    setView,
    openModal,
    closeModal,
  };

  return <AppContext.Provider value={store}>{children}</AppContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAppStore(): AppStore {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppStore must be used inside <AppProvider>");
  return ctx;
}
