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

/**
 * Header bar — never scrolls, shrinks to its natural height.
 * flexShrink:0 keeps it pinned while the body scrolls below.
 */
export const modalHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 20px",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

/**
 * Scrollable body region — takes remaining height, scrolls internally.
 * flex:1 + overflowY:auto is the canonical "fixed header + scroll body"
 * pattern inside a column flex container.
 */
export const modalBodyStyle: React.CSSProperties = {
  overflowY: "auto",
  flex: 1,
  padding: "20px 24px 32px",
};
