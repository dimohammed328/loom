import React from "react";
import { AppProvider, useAppStore } from "./state/store";
import TopBar from "./components/TopBar";
import BoardView from "./components/BoardView";
import TableView from "./components/TableView";
import DagView from "./components/DagView";

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
        {view.charAt(0).toUpperCase() + view.slice(1)} view coming soon.
      </span>
    </div>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <div className="app">
        <TopBar />
        <ViewRouter />
      </div>
    </AppProvider>
  );
}
