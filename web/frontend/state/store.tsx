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
import type { ProjectSummary, ItemNode } from "../api/client";
import { setItems as buildItemsMap, applyWsPayload as applyPayload, type ItemsMap } from "./itemsReducer";
import type { SsePayload as WsPayload } from "../sse/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type View = "board" | "table" | "graph";

/**
 * Registered by the active table view so TopBar can surface the
 * Expand/Collapse-all button.
 */
export interface CollapseControl {
  /** True when every collapsible row is currently collapsed. */
  isAllCollapsed: boolean;
  /** Toggles all rows between fully expanded and fully collapsed. */
  toggle: () => void;
}

export interface AppState {
  /** All projects returned from /api/projects (null = not yet loaded). */
  projects: ProjectSummary[] | null;
  /** Currently selected project, or null if none loaded yet. */
  currentProject: ProjectSummary | null;
  /** Active top-level view. */
  view: View;
  /** qid of item shown in modal, or null. */
  openQid: string | null;
  /**
   * Collapse control registered by the table view, or null when no table
   * view is mounted. TopBar renders the Expand/Collapse-all button only
   * when this is non-null.
   */
  collapseControl: CollapseControl | null;
  /**
   * Flat map of all items for the current project, keyed by qid.
   * Null until the first tree fetch completes.
   * Updated in-place by WS payloads so all views reflect live changes.
   */
  itemsById: ItemsMap | null;
}

export interface AppActions {
  setProjects: (projects: ProjectSummary[]) => void;
  setCurrentProject: (project: ProjectSummary) => void;
  setView: (view: View) => void;
  openModal: (qid: string) => void;
  closeModal: () => void;
  /** Called by TableView to register / update the collapse control. */
  setCollapseControl: (ctrl: CollapseControl | null) => void;
  /** Replace the full items map (called after a tree fetch). */
  setItemsFromTree: (items: ItemNode[]) => void;
  /** Apply a single WS payload — replace or remove the item by qid. */
  applyWsPayload: (payload: WsPayload) => void;
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
  const [collapseControl, setCollapseControlState] = useState<CollapseControl | null>(null);
  const [itemsById, setItemsByIdState] = useState<ItemsMap | null>(null);

  const setProjects = useCallback((ps: ProjectSummary[]) => {
    setProjectsState(ps);
    // Auto-select the first project if none is selected yet.
    setCurrentProjectState((prev) => prev ?? (ps[0] ?? null));
  }, []);

  const setCurrentProject = useCallback((p: ProjectSummary) => {
    setCurrentProjectState(p);
    setViewState("board");
    setCollapseControlState(null);
    setItemsByIdState(null); // clear stale items on project switch
  }, []);

  const setView = useCallback((v: View) => {
    setViewState(v);
    // Clear collapse control when switching away from the table view.
    if (v !== "table") setCollapseControlState(null);
  }, []);
  const openModal = useCallback((qid: string) => setOpenQid(qid), []);
  const closeModal = useCallback(() => setOpenQid(null), []);
  const setCollapseControl = useCallback(
    (ctrl: CollapseControl | null) => setCollapseControlState(ctrl),
    [],
  );

  const setItemsFromTree = useCallback((items: ItemNode[]) => {
    setItemsByIdState(buildItemsMap(items));
  }, []);

  const applyWsPayloadAction = useCallback((payload: WsPayload) => {
    setItemsByIdState((prev) => {
      if (!prev) return prev; // no tree loaded yet — ignore
      return applyPayload(prev, payload);
    });
  }, []);

  const store: AppStore = {
    projects,
    currentProject,
    view,
    openQid,
    collapseControl,
    itemsById,
    setProjects,
    setCurrentProject,
    setView,
    openModal,
    closeModal,
    setCollapseControl,
    setItemsFromTree,
    applyWsPayload: applyWsPayloadAction,
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
