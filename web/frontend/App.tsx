import React, { useEffect, useRef } from "react";
import { AppProvider, useAppStore } from "./state/store";
import TopBar from "./components/TopBar";
import BoardView from "./components/BoardView";
import TableView from "./components/TableView";
import DagView from "./components/DagView";
import { ConnectedItemModal } from "./components/ItemModal";
import { createWsClient } from "./ws/client";
import type { WsPayload, WsClient } from "./ws/client";
import { shouldRefetchModal } from "./state/wsIntegration";

// ---------------------------------------------------------------------------
// WS connector — lives inside AppProvider so it can access the store
// ---------------------------------------------------------------------------

function WsConnector(): null {
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
  const modalRefetchRef = useRef<((payload: WsPayload) => void) | null>(null);
  // Publish the ref so ConnectedItemModal can register its callback.
  _modalRefetchRef = modalRefetchRef;

  useEffect(() => {
    const client: WsClient = createWsClient({
      url: "/ws",
      onMessage: (payload: WsPayload) => {
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
let _modalRefetchRef: React.MutableRefObject<((payload: WsPayload) => void) | null> | null = null;

export function registerModalRefetch(
  cb: ((payload: WsPayload) => void) | null,
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
      <WsConnector />
      <div className="app">
        <TopBar />
        <ViewRouter />
        <ConnectedItemModal />
      </div>
    </AppProvider>
  );
}
