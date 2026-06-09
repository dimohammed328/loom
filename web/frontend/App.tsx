import React, { useEffect, useRef } from "react";
import { AppProvider, useAppStore } from "./state/store";
import TopBar from "./components/TopBar";
import BoardView from "./components/BoardView";
import TableView from "./components/TableView";
import DagView from "./components/DagView";
import { ConnectedItemModal } from "./components/ItemModal";
import { createSseClient } from "./sse/client";
import type { SsePayload, SseClient } from "./sse/client";
import { shouldRefetchModal } from "./state/wsIntegration";
import { getProjectTree } from "./api/client";

// ---------------------------------------------------------------------------
// ProjectLoader — seeds the store from an initial tree fetch
//
// Runs once per currentProject change. Calls setItemsFromTree so that
// itemsById is populated before the views render. Also resets itemsById to
// null on project switch (handled in setCurrentProject in the store).
// ---------------------------------------------------------------------------

function ProjectLoader(): null {
  const { currentProject, setItemsFromTree } = useAppStore();

  useEffect(() => {
    if (!currentProject) return;
    getProjectTree(currentProject.qid)
      .then((tree) => {
        setItemsFromTree(tree.items);
      })
      .catch((err: unknown) => {
        console.error("ProjectLoader: failed to load tree:", err);
      });
  }, [currentProject, setItemsFromTree]);

  return null;
}

// ---------------------------------------------------------------------------
// SSE connector — lives inside AppProvider so it can access the store
// ---------------------------------------------------------------------------

function SseConnector(): null {
  const { applyWsPayload, openQid } = useAppStore();

  // Keep a stable ref to openQid so the onMessage callback can read the
  // current value without being recreated on every render.
  const openQidRef = useRef<string | null>(openQid);
  useEffect(() => {
    openQidRef.current = openQid;
  }, [openQid]);

  // Keep a ref to applyWsPayload for the same reason.
  const applyRef = useRef(applyWsPayload);
  useEffect(() => {
    applyRef.current = applyWsPayload;
  }, [applyWsPayload]);

  // modalRefetchRef is set by ConnectedItemModal when it wants to be notified.
  // We expose it via a module-level ref below.
  const modalRefetchRef = useRef<((payload: SsePayload) => void) | null>(null);
  // Publish the ref so ConnectedItemModal can register its callback.
  _modalRefetchRef = modalRefetchRef;

  useEffect(() => {
    const client: SseClient = createSseClient({
      url: "/api/events",
      onMessage: (payload: SsePayload) => {
        applyRef.current(payload);
        if (shouldRefetchModal(openQidRef.current, payload)) {
          modalRefetchRef.current?.(payload);
        }
      },
    });
    client.connect();
    return () => client.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentional once-only

  return null;
}

/**
 * Module-level mutable ref so ConnectedItemModal can register its refetch
 * callback without prop drilling.  This is an intentional escape hatch; the
 * alternative (another context) is heavier for a single callback.
 */
let _modalRefetchRef: React.MutableRefObject<((payload: SsePayload) => void) | null> | null = null;

export function registerModalRefetch(
  cb: ((payload: SsePayload) => void) | null,
): void {
  if (_modalRefetchRef) _modalRefetchRef.current = cb;
}

// ---------------------------------------------------------------------------
// ViewRouter
// ---------------------------------------------------------------------------

function ViewRouter(): React.JSX.Element {
  const { view, currentProject, openModal } = useAppStore();

  if (!currentProject) {
    return (
      <div
        className="view-scroll"
        style={{ display: "grid", placeItems: "center", minHeight: 200 }}
      >
        <span style={{ color: "var(--text-3)", fontSize: 13 }}>
          Select a project to get started.
        </span>
      </div>
    );
  }

  if (view === "board") {
    return <BoardView project={currentProject} onOpen={openModal} />;
  }

  if (view === "table") {
    return <TableView project={currentProject} onOpen={openModal} />;
  }

  if (view === "graph") {
    return <DagView project={currentProject} onOpen={openModal} />;
  }

  return (
    <div
      className="view-scroll"
      style={{ display: "grid", placeItems: "center", minHeight: 200 }}
    >
      <span style={{ color: "var(--text-3)", fontSize: 13 }}>
        {(view as string).charAt(0).toUpperCase() + (view as string).slice(1)} view coming soon.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <ProjectLoader />
      <SseConnector />
      <div className="app">
        <TopBar />
        <ViewRouter />
        <ConnectedItemModal />
      </div>
    </AppProvider>
  );
}
