import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/motion.css";
import { initTheme } from "./theme";

// Apply persisted theme before first paint to avoid a flash of wrong theme.
initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
