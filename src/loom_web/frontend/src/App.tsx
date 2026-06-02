import React from "react";
import { AppProvider } from "./state/store";

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <div className="app">
        <p style={{ padding: "1rem", color: "var(--text-2)" }}>Loom — loading…</p>
      </div>
    </AppProvider>
  );
}
