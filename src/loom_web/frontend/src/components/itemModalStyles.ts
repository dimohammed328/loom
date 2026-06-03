/**
 * Pure style objects for ItemModal layout.
 * Extracted so they can be unit-tested without a DOM / renderer.
 */
import type React from "react";

/** Full-viewport scrim — centered both axes. */
export const modalScrimStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

/** Panel sizing: ≤75vh tall, bounded width, full border-radius. */
export const modalPanelStyle: React.CSSProperties = {
  background: "var(--surface)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--pop-shadow)",
  width: "min(720px, 100vw)",
  maxHeight: "75vh",
  display: "flex",
  flexDirection: "column",
  outline: "none",
  animation: "modal-rise 0.22s ease",
};
