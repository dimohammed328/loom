/**
 * StoryCard — a single story card in the board Kanban grid.
 *
 * Shows:
 *  - Story title
 *  - Tag chips (if any)
 *  - Qid chip
 *  - Either a task meter OR a blocked/dep indicator in the footer
 *
 * Clicking the card calls onOpen with the story's qid.
 */

import React from "react";
import type { StoryCell } from "../boardModel";
import { storyProgress } from "../progress";

// ---------------------------------------------------------------------------
// Pure helper (exported for tests)
// ---------------------------------------------------------------------------

export type FooterKind = "tasks" | "blocked" | "deps" | null;

/**
 * Determine which footer variant to render for a story card.
 *
 * Priority:
 *  1. "tasks" — story has at least one task (task meter shown)
 *  2. "blocked" — story status is "blocked" (blocked indicator shown)
 *  3. "deps" — story has dependency qids (dep count shown)
 *  4. null — nothing in footer beyond the qid
 */
export function storyFooterKind(story: StoryCell): FooterKind {
  if (story.taskNodes.length > 0) return "tasks";
  if (story.status === "blocked") return "blocked";
  if (story.deps.length > 0) return "deps";
  return null;
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

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

function IconBlock(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6.2 6.2l11.6 11.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function IconDep(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QidChip({ id }: { id: string }): React.JSX.Element {
  return (
    <span className="qid kid">
      <span className="qid-hash">
        <IconHash />
      </span>
      <span className="qid-text mono">{id}</span>
    </span>
  );
}

/** Tag chip with OKLCH-derived color from tag name hue. */
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

function TaskMeter({ story }: { story: StoryCell }): React.JSX.Element {
  const { done, total } = storyProgress(story);
  return (
    <span className="task-meter" title={`${done}/${total} tasks done`}>
      <span className="tm-ticks">
        {story.taskNodes.map((t) => (
          <span
            key={t.qid}
            className="tm-tick"
            style={{
              background: t.status === "done" ? "var(--text-2)" : "var(--border-strong)",
            }}
          />
        ))}
      </span>
      <span className="tm-count mono">
        {done}/{total}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// StoryCard
// ---------------------------------------------------------------------------

export interface StoryCardProps {
  story: StoryCell;
  /** Tags from the item detail (not on StoryCell directly — passed separately). */
  tags?: string[];
  onOpen: (qid: string) => void;
}

export default function StoryCard({ story, tags = [], onOpen }: StoryCardProps): React.JSX.Element {
  const footerKind = storyFooterKind(story);

  return (
    <div
      className="kcard"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(story.qid)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(story.qid);
        }
      }}
    >
      {/* Title */}
      <div className="ktop">
        <div className="ktitle">{story.title}</div>
      </div>

      {/* Tag chips */}
      {tags.length > 0 && (
        <div className="ktags">
          {tags.map((t) => (
            <TagChip key={t} tag={t} />
          ))}
        </div>
      )}

      {/* Bottom block: qid + footer indicator */}
      <div className="kbottom">
        <div className="kfoot">
          <QidChip id={story.qid} />
          {footerKind === "blocked" && (
            <span className="kblock">
              <IconBlock /> blocked
            </span>
          )}
          {footerKind === "deps" && (
            <span className="kdep">
              <IconDep /> {story.deps.length} dep{story.deps.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {footerKind === "tasks" && <TaskMeter story={story} />}
      </div>
    </div>
  );
}
