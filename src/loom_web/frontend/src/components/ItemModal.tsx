/**
 * ItemModal — unified detail modal for epics, stories, and tasks.
 *
 * Opens via `openQid` from the app store. Loads detail from GET /api/items/{qid}.
 * Sections render based on item type:
 *   - Type pill + qid
 *   - Breadcrumb
 *   - Title
 *   - Meta strip (status, assignee, updated, tags, progress)
 *   - Description body
 *   - Dependencies (depends-on / blocks)
 *   - Children list
 *
 * Backdrop click and Esc close the modal; focus is trapped inside.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { getItem } from "../api/client";
import type { ItemDetail, ItemRef } from "../api/client";
import { statusColor } from "../status";
import { useAppStore } from "../state/store";
import {
  breadcrumbSegments,
  childListLabel,
  typePillLabel,
} from "./itemModalHelpers";

// Re-export pure helpers so callers can import from one place.
export { breadcrumbSegments, childListLabel, typePillLabel };

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

function IconX(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconHash(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 4.2L8 19.8M16 4.2L14 19.8M4.8 9H19.6M4.4 15H19.2"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconDep(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12h13M12 7l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconUser(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4 20c0-4 3.58-7 8-7s8 3 8 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StatusDot({ status }: { status: string | null }): React.JSX.Element {
  const colors = statusColor(status);
  return (
    <span
      className="dot"
      style={{ background: colors.dot, width: 8, height: 8, borderRadius: "50%", display: "inline-block", flexShrink: 0 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QidChip({ qid, className = "" }: { qid: string; className?: string }): React.JSX.Element {
  return (
    <span className={`qid ${className}`}>
      <span className="qid-hash">
        <IconHash />
      </span>
      <span className="qid-text mono">{qid}</span>
    </span>
  );
}

const TAG_HUES: Record<string, number> = {
  backend: 212,
  frontend: 280,
  design: 332,
  auth: 38,
  payments: 152,
  data: 195,
  infra: 45,
  mobile: 222,
  security: 0,
};

function tagStyle(tag: string): React.CSSProperties {
  const hue = TAG_HUES[tag] ?? 250;
  return {
    background: `oklch(var(--tag-bg-l, 0.95) calc(var(--tag-bg-c, 0.055) * var(--tag-sat)) ${hue})`,
    color: `oklch(var(--tag-fg-l, 0.46) calc(var(--tag-fg-c, 0.09) * var(--tag-sat)) ${hue})`,
  };
}

function TagChip({ tag }: { tag: string }): React.JSX.Element {
  return (
    <span className="tag-chip" style={tagStyle(tag)}>
      {tag}
    </span>
  );
}

function StatusPill({ status }: { status: string | null }): React.JSX.Element {
  const label = status ?? "—";
  const colors = statusColor(status);
  return (
    <span
      className="status-pill"
      style={{ background: colors.bg, color: colors.fg }}
    >
      <StatusDot status={status} />
      {label}
    </span>
  );
}

/** A reference row for children / dependency lists. */
function RefRow({
  item,
  onOpen,
}: {
  item: ItemRef;
  onOpen: (qid: string) => void;
}): React.JSX.Element {
  const colors = statusColor(item.status);
  return (
    <button
      className="bare ref-row"
      onClick={() => onOpen(item.qid)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 0",
        width: "100%",
        textAlign: "left",
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
        transition: "background .1s",
      }}
    >
      <StatusDot status={item.status} />
      <span
        style={{
          flex: 1,
          fontSize: 13,
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: colors.fg !== "var(--text-2)" ? "var(--text)" : "var(--text-2)",
        }}
      >
        {item.title}
      </span>
      <QidChip qid={item.qid} />
    </button>
  );
}

/** A children reference row (uses just a qid string, not an ItemRef). */
function ChildRow({
  qid,
  onOpen,
}: {
  qid: string;
  onOpen: (qid: string) => void;
}): React.JSX.Element {
  return (
    <button
      className="bare ref-row"
      onClick={() => onOpen(qid)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 0",
        width: "100%",
        textAlign: "left",
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
      }}
    >
      <QidChip qid={qid} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading / error / empty states
// ---------------------------------------------------------------------------

function LoadingState(): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: 180,
        color: "var(--text-3)",
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}

function ErrorState({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: 180,
        color: "var(--st-blocked-fg)",
        fontSize: 13,
        padding: "0 24px",
        textAlign: "center",
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ItemModal
// ---------------------------------------------------------------------------

export interface ItemModalProps {
  qid: string | null;
  onClose: () => void;
  onOpen: (qid: string) => void;
}

export default function ItemModal({
  qid,
  onClose,
  onOpen,
}: ItemModalProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch detail whenever qid changes.
  useEffect(() => {
    if (!qid) return;
    setDetail(null);
    setError(null);
    setLoading(true);
    getItem(qid)
      .then((d) => {
        setDetail(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [qid]);

  // Focus management: move focus into dialog on open; restore on close.
  useEffect(() => {
    if (qid) {
      if (!openerRef.current) {
        openerRef.current = document.activeElement;
      }
      const panel = panelRef.current;
      if (panel) panel.focus();

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          onClose();
          return;
        }
        if (e.key === "Tab" && panel) {
          const focusable = panel.querySelectorAll<HTMLElement>(
            'button, a[href], input, [tabindex]:not([tabindex="-1"])',
          );
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    } else if (openerRef.current) {
      const opener = openerRef.current as HTMLElement;
      openerRef.current = null;
      opener.focus?.();
    }
  }, [qid, onClose]);

  if (!qid) return null;

  const crumbs = breadcrumbSegments(qid);

  return (
    <div
      className="modal-scrim"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        className="modal-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title-h"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          borderRadius: "var(--radius) var(--radius) 0 0",
          boxShadow: "var(--pop-shadow)",
          width: "min(720px, 100vw)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          outline: "none",
          animation: "modal-rise 0.22s ease",
        }}
      >
        {/* ---- Modal header ---- */}
        <div
          className="modal-head"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 20px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {/* Type pill */}
          {detail && (
            <span
              className={`type-pill type-${detail.type}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 10px",
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 650,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                color: "var(--text-2)",
                letterSpacing: "0.03em",
                textTransform: "uppercase",
                flexShrink: 0,
              }}
            >
              {typePillLabel(detail.type)}
            </span>
          )}

          {/* Qid */}
          <QidChip
            qid={qid}
            className="modal-qid"
          />

          <div style={{ flex: 1 }} />

          {/* Close button */}
          <button
            className="bare modal-x"
            aria-label="Close"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: "var(--radius-sm)",
              color: "var(--text-3)",
              flexShrink: 0,
              transition: "background .1s, color .1s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--hover)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-3)";
            }}
          >
            <IconX />
          </button>
        </div>

        {/* ---- Scrollable body ---- */}
        <div
          className="modal-body"
          style={{ overflowY: "auto", flex: 1, padding: "20px 24px 32px" }}
        >
          {/* Breadcrumb */}
          <nav
            aria-label="Item location"
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 4,
              marginBottom: 10,
            }}
          >
            {crumbs.map((seg, i) => (
              <React.Fragment key={i}>
                {i > 0 && (
                  <span style={{ color: "var(--text-3)", fontSize: 12 }}>/</span>
                )}
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: i === crumbs.length - 1 ? 600 : 400,
                    color: i === crumbs.length - 1 ? "var(--text-2)" : "var(--text-3)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {seg}
                </span>
              </React.Fragment>
            ))}
          </nav>

          {/* Title */}
          {detail && (
            <h1
              id="modal-title-h"
              style={{
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                lineHeight: 1.3,
                margin: "0 0 18px",
                color: "var(--text)",
              }}
            >
              {detail.title}
            </h1>
          )}

          {/* Loading / error states */}
          {loading && <LoadingState />}
          {error && <ErrorState message={error} />}

          {/* ---- Detail content ---- */}
          {detail && (
            <>
              {/* Meta strip */}
              <div
                className="modal-meta"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px 20px",
                  padding: "14px 16px",
                  background: "var(--surface-2)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                  marginBottom: 22,
                }}
              >
                {/* Status */}
                <div
                  className="mm-item"
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}
                  >
                    Status
                  </span>
                  <StatusPill status={detail.status} />
                </div>

                {/* Assignee */}
                <div
                  className="mm-item"
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}
                  >
                    Assignee
                  </span>
                  {detail.assignee ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 13,
                        color: "var(--text-2)",
                      }}
                    >
                      <span
                        className="agent-badge"
                        style={{ width: 20, height: 20 }}
                      >
                        <IconUser />
                      </span>
                      <span className="mono" style={{ fontSize: 11.5 }}>
                        {detail.assignee}
                      </span>
                    </span>
                  ) : (
                    <span style={{ fontSize: 13, color: "var(--text-3)" }}>—</span>
                  )}
                </div>

                {/* Progress (for epics / stories with children) */}
                {detail.children.length > 0 && (
                  <div
                    className="mm-item"
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span
                      style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}
                    >
                      Progress
                    </span>
                    <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                      {detail.children.length} child{detail.children.length !== 1 ? "ren" : ""}
                    </span>
                  </div>
                )}

                {/* Tags */}
                {detail.tags.length > 0 && (
                  <div
                    className="mm-item"
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span
                      style={{ fontSize: 11, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}
                    >
                      Tags
                    </span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {detail.tags.map((t) => (
                        <TagChip key={t} tag={t} />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Description */}
              <section className="modal-section" style={{ marginBottom: 22 }}>
                <div
                  className="ms-label"
                  style={{
                    fontSize: 12,
                    fontWeight: 650,
                    color: "var(--text-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 10,
                  }}
                >
                  Description
                </div>
                {detail.body ? (
                  <p
                    className="modal-prose"
                    style={{
                      fontSize: 14,
                      color: "var(--text)",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      margin: 0,
                    }}
                  >
                    {detail.body}
                  </p>
                ) : (
                  <p
                    className="modal-prose empty"
                    style={{ fontSize: 13.5, color: "var(--text-3)", fontStyle: "italic", margin: 0 }}
                  >
                    No description yet.
                  </p>
                )}
              </section>

              {/* Dependencies */}
              {(detail.dependencies.length > 0 || detail.dependents.length > 0) && (
                <div
                  className="modal-cols"
                  style={{
                    display: "grid",
                    gridTemplateColumns: detail.dependencies.length > 0 && detail.dependents.length > 0 ? "1fr 1fr" : "1fr",
                    gap: 16,
                    marginBottom: 22,
                  }}
                >
                  {detail.dependencies.length > 0 && (
                    <section className="modal-section">
                      <div
                        className="ms-label"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 12,
                          fontWeight: 650,
                          color: "var(--text-3)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          marginBottom: 6,
                        }}
                      >
                        <IconDep />
                        Depends on
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            background: "var(--surface-2)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            padding: "0 6px",
                            lineHeight: "16px",
                          }}
                        >
                          {detail.dependencies.length}
                        </span>
                      </div>
                      <div className="ref-list">
                        {detail.dependencies.map((dep) => (
                          <RefRow key={dep.qid} item={dep} onOpen={onOpen} />
                        ))}
                      </div>
                    </section>
                  )}

                  {detail.dependents.length > 0 && (
                    <section className="modal-section">
                      <div
                        className="ms-label"
                        style={{
                          fontSize: 12,
                          fontWeight: 650,
                          color: "var(--text-3)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          marginBottom: 6,
                        }}
                      >
                        Blocks
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 11,
                            fontWeight: 600,
                            background: "var(--surface-2)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            padding: "0 6px",
                            lineHeight: "16px",
                          }}
                        >
                          {detail.dependents.length}
                        </span>
                      </div>
                      <div className="ref-list">
                        {detail.dependents.map((dep) => (
                          <RefRow key={dep.qid} item={dep} onOpen={onOpen} />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}

              {/* Children list */}
              {(() => {
                const label = childListLabel(detail);
                if (!label) return null;
                return (
                  <section className="modal-section">
                    <div
                      className="ms-label"
                      style={{
                        fontSize: 12,
                        fontWeight: 650,
                        color: "var(--text-3)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        marginBottom: 6,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {label}
                      {detail.children.length > 0 && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            background: "var(--surface-2)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            padding: "0 6px",
                            lineHeight: "16px",
                          }}
                        >
                          {detail.children.length}
                        </span>
                      )}
                    </div>
                    {detail.children.length === 0 ? (
                      <p
                        style={{ fontSize: 13.5, color: "var(--text-3)", fontStyle: "italic", margin: 0 }}
                      >
                        No {label.toLowerCase()} yet.
                      </p>
                    ) : (
                      <div className="ref-list">
                        {detail.children.map((childQid) => (
                          <ChildRow key={childQid} qid={childQid} onOpen={onOpen} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })()}
            </>
          )}
        </div>
      </div>

      {/* Modal rise animation */}
      <style>{`
        @keyframes modal-rise {
          from { transform: translateY(24px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected wrapper — reads/writes the app store directly
// ---------------------------------------------------------------------------

export function ConnectedItemModal(): React.JSX.Element | null {
  const { openQid, closeModal, openModal } = useAppStore();
  return (
    <ItemModal
      qid={openQid}
      onClose={closeModal}
      onOpen={useCallback((qid: string) => {
        closeModal();
        // Small tick so the close animation can start before re-opening.
        setTimeout(() => openModal(qid), 50);
      }, [closeModal, openModal])}
    />
  );
}
