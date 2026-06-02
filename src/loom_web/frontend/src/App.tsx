import React from "react";
import { AppProvider } from "./state/store";
import TopBar from "./components/TopBar";

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <div className="app">
        <TopBar />
        <main className="view-scroll" />
      </div>
    </AppProvider>
  );
}
