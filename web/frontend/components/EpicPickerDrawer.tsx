/**
 * EpicPickerDrawer — collapsible right-side drawer for picking an epic.
 *
 * When open, shows a searchable list of epics. Selecting an epic fires
 * onSelectEpic with the epic qid. The drawer can be toggled open/closed
 * via the toggle button on its left edge.
 */

import React, { useState, useCallback, useMemo } from "react";
import type { ItemNode } from "../api/client";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EpicPickerDrawerProps {
  /** All epic-type nodes from the tree, used to build the list. */
  epics: ItemNode[];
  /** Currently selected epic qid. */
  selectedEpicQid: string | null;
  /** Called when the user picks an epic. */
  onSelectEpic: (epicQid: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EpicPickerDrawer({
  epics,
  selectedEpicQid,
  onSelectEpic,
}: EpicPickerDrawerProps): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");

  const toggleDrawer = useCallback(() => setOpen((v) => !v), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return epics;
    return epics.filter(
      (e) =>
        (e.title ?? "").toLowerCase().includes(q) ||
        e.qid.toLowerCase().includes(q),
    );
  }, [epics, query]);

  return (
    <aside className={`epic-drawer${open ? " open" : ""}`} aria-label="Epic picker">
      {/* Toggle button on the left edge */}
      <button
        className="epic-drawer-toggle bare"
        onClick={toggleDrawer}
        aria-expanded={open}
        aria-controls="epic-drawer-panel"
        title={open ? "Collapse epic picker" : "Expand epic picker"}
      >
        <span className="epic-drawer-toggle-icon">{open ? "›" : "‹"}</span>
      </button>

      {/* Drawer panel */}
      <div id="epic-drawer-panel" className="epic-drawer-panel" aria-hidden={!open}>
        <div className="epic-drawer-head">
          <span className="epic-drawer-title">Epics</span>
          <span className="epic-drawer-count">{epics.length}</span>
        </div>

        <div className="epic-drawer-search">
          <input
            className="epic-drawer-input"
            type="search"
            placeholder="Filter epics…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            aria-label="Filter epics"
          />
        </div>

        <ul className="epic-drawer-list" role="listbox" aria-label="Epics">
          {filtered.length === 0 ? (
            <li className="epic-drawer-empty">No epics match</li>
          ) : (
            filtered.map((epic) => (
              <li key={epic.qid} role="option" aria-selected={epic.qid === selectedEpicQid}>
                <button
                  className={`epic-drawer-item bare${epic.qid === selectedEpicQid ? " selected" : ""}`}
                  onClick={() => onSelectEpic(epic.qid)}
                >
                  <span className="edi-title">{epic.title ?? epic.qid}</span>
                  <span className="edi-id">{epic.qid}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </aside>
  );
}
