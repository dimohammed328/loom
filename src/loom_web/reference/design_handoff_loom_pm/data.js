/* Loom sample data — generic SaaS product team.
 * Hierarchy: project -> epic -> story -> task, with cross-cutting deps.
 * All views are scoped to a single project at a time.
 * Kanban cards & DAG nodes are STORIES. Table is epic>story>task. */

// Story statuses (loom allows any string; this team's stories never enter review —
// review is an epic-level sign-off gate, see epic.review below). Order = kanban columns.
const STATUSES = ["ready", "in progress", "blocked", "done"];

// Assignees are AI agent sessions, not people. Keyed handle -> session id + hue.
const PEOPLE = {
  maya:  { session: "sess_7f3a9c", hue: 265 },
  dan:   { session: "sess_2b8e41", hue: 200 },
  priya: { session: "sess_c1d6f0", hue: 150 },
  leo:   { session: "sess_94a7b2", hue: 25  },
  sam:   { session: "sess_e5102d", hue: 330 },
};

// helper to keep timestamps terse
const d = (s) => s; // already display-ready strings

const PROJECTS = [
  {
    id: "helios",
    icon: "📊",
    title: "Helios",
    subtitle: "Core analytics platform",
    repo: "github.com/northwind/helios",
    default_branch: "main",
    epics: [
      {
        id: "k7m2x9p",
        title: "Onboarding 2.0",
        accent: "violet",
        stories: [
          {
            id: 1, title: "Email verification step", status: "done",
            assignee: "dan", tags: ["backend", "auth"], updated: "May 21",
            depends_on: [],
            tasks: [
              { id: 1, title: "Send verification email on signup", status: "done", assignee: "dan", updated: "May 18" },
              { id: 2, title: "Token expiry + resend flow", status: "done", assignee: "dan", updated: "May 21" },
            ],
          },
          {
            id: 2, title: "Welcome flow redesign", status: "in progress",
            assignee: "maya", tags: ["design", "frontend"], updated: "May 28",
            depends_on: ["helios:k7m2x9p:1"],
            tasks: [
              { id: 1, title: "Hero illustration + copy", status: "done", assignee: "maya", updated: "May 24" },
              { id: 2, title: "Build stepper component", status: "in progress", assignee: "maya", updated: "May 28" },
              { id: 3, title: "Progress persistence", status: "ready", assignee: "leo", updated: "May 26" },
            ],
          },
          {
            id: 3, title: "Org workspace setup", status: "in progress",
            assignee: "priya", tags: ["frontend"], updated: "May 27",
            depends_on: ["helios:k7m2x9p:2"],
            tasks: [
              { id: 1, title: "Invite teammates modal", status: "in progress", assignee: "priya", updated: "May 27" },
              { id: 2, title: "Role picker", status: "done", assignee: "priya", updated: "May 25" },
            ],
          },
          {
            id: 4, title: "Sample data seeding", status: "ready",
            assignee: "leo", tags: ["backend"], updated: "May 23",
            depends_on: ["helios:k7m2x9p:3"],
            tasks: [
              { id: 1, title: "Seed dashboard fixtures", status: "ready", assignee: "leo", updated: "May 23" },
            ],
          },
          {
            id: 5, title: "Onboarding analytics events", status: "blocked",
            assignee: "maya", tags: ["data"], updated: "May 22",
            depends_on: ["helios:k7m2x9p:2", "helios:k7m2x9p:3"],
            tasks: [
              { id: 1, title: "Define funnel event schema", status: "ready", assignee: "maya", updated: "May 22" },
              { id: 2, title: "Wire events into stepper", status: "blocked", assignee: "leo", updated: "May 20" },
            ],
          },
        ],
      },
      {
        id: "b3n8q4r",
        title: "Billing & Invoicing",
        accent: "amber",
        stories: [
          {
            id: 1, title: "Stripe subscription sync", status: "in progress",
            assignee: "dan", tags: ["backend", "payments"], updated: "May 28",
            depends_on: [],
            tasks: [
              { id: 1, title: "Webhook endpoint", status: "done", assignee: "dan", updated: "May 26" },
              { id: 2, title: "Reconcile plan changes", status: "in progress", assignee: "dan", updated: "May 28" },
            ],
          },
          {
            id: 2, title: "Plan upgrade modal", status: "in progress",
            assignee: "maya", tags: ["frontend", "design"], updated: "May 27",
            depends_on: [],
            tasks: [],
          },
          {
            id: 3, title: "Invoice PDF export", status: "ready",
            assignee: "sam", tags: ["backend"], updated: "May 24",
            depends_on: [],
            tasks: [
              { id: 1, title: "Template engine", status: "ready", assignee: "sam", updated: "May 24" },
            ],
          },
          {
            id: 4, title: "Proration logic", status: "blocked",
            assignee: "dan", tags: ["backend", "payments"], updated: "May 20",
            depends_on: ["helios:b3n8q4r:1"],
            tasks: [],
          },
          {
            id: 5, title: "Dunning emails", status: "ready",
            assignee: "priya", tags: ["backend"], updated: "May 19",
            depends_on: [],
            tasks: [],
          },
        ],
      },
      {
        id: "t6w1c5h",
        title: "Realtime Notifications",
        accent: "blue",
        review: "in review",
        reviewer: "maya",
        reviewDate: "May 30",
        stories: [
          {
            id: 1, title: "WebSocket gateway", status: "done",
            assignee: "leo", tags: ["backend", "infra"], updated: "May 15",
            depends_on: [],
            tasks: [
              { id: 1, title: "Connection manager", status: "done", assignee: "leo", updated: "May 14" },
              { id: 2, title: "Auth handshake", status: "done", assignee: "leo", updated: "May 15" },
            ],
          },
          {
            id: 2, title: "In-app toast system", status: "done",
            assignee: "maya", tags: ["frontend"], updated: "May 26",
            depends_on: ["helios:t6w1c5h:1"],
            tasks: [],
          },
          {
            id: 3, title: "Notification preferences UI", status: "done",
            assignee: "priya", tags: ["frontend"], updated: "May 27",
            depends_on: [],
            tasks: [
              { id: 1, title: "Channel toggles", status: "done", assignee: "priya", updated: "May 27" },
            ],
          },
          {
            id: 4, title: "Push notification service", status: "done",
            assignee: "dan", tags: ["backend"], updated: "May 22",
            depends_on: ["helios:t6w1c5h:1"],
            tasks: [],
          },
        ],
      },
      {
        id: "backlog",
        title: "Backlog",
        accent: "slate",
        stories: [
          {
            id: 1, title: "Dark mode pass", status: "ready",
            assignee: "maya", tags: ["design", "frontend"], updated: "May 12",
            depends_on: [], tasks: [],
          },
          {
            id: 2, title: "CSV export rate limit", status: "ready",
            assignee: "sam", tags: ["backend"], updated: "May 10",
            depends_on: [], tasks: [],
          },
        ],
      },
    ],
  },

  {
    id: "orbit",
    icon: "📱",
    title: "Orbit",
    subtitle: "Mobile companion app",
    repo: "github.com/northwind/orbit",
    default_branch: "main",
    epics: [
      {
        id: "m9k4p2x",
        title: "Offline sync",
        accent: "blue",
        stories: [
          { id: 1, title: "Local cache layer", status: "in progress", assignee: "leo", tags: ["mobile"], updated: "May 28", depends_on: [], tasks: [] },
          { id: 2, title: "Conflict resolution", status: "blocked", assignee: "dan", tags: ["mobile", "data"], updated: "May 24", depends_on: ["orbit:m9k4p2x:1"], tasks: [] },
          { id: 3, title: "Sync status indicator", status: "ready", assignee: "priya", tags: ["mobile", "design"], updated: "May 22", depends_on: ["orbit:m9k4p2x:1"], tasks: [] },
        ],
      },
      {
        id: "w2h7n3q",
        title: "Push & deep links",
        accent: "violet",
        review: "done",
        reviewer: "dan",
        reviewDate: "May 28",
        stories: [
          { id: 1, title: "APNs + FCM setup", status: "done", assignee: "leo", tags: ["mobile", "infra"], updated: "May 16", depends_on: [], tasks: [] },
          { id: 2, title: "Deep link router", status: "done", assignee: "maya", tags: ["mobile"], updated: "May 27", depends_on: ["orbit:w2h7n3q:1"], tasks: [] },
        ],
      },
      {
        id: "backlog",
        title: "Backlog",
        accent: "slate",
        stories: [
          { id: 1, title: "Biometric unlock", status: "ready", assignee: "sam", tags: ["mobile", "auth"], updated: "May 09", depends_on: [], tasks: [] },
        ],
      },
    ],
  },

  {
    id: "atlas",
    icon: "🧭",
    title: "Atlas",
    subtitle: "Billing & admin console",
    repo: "github.com/northwind/atlas",
    default_branch: "main",
    epics: [
      {
        id: "q5r8t1k",
        title: "Admin RBAC",
        accent: "amber",
        stories: [
          { id: 1, title: "Permission model", status: "done", assignee: "dan", tags: ["backend", "auth"], updated: "May 18", depends_on: [], tasks: [] },
          { id: 2, title: "Role editor UI", status: "in progress", assignee: "priya", tags: ["frontend"], updated: "May 28", depends_on: ["atlas:q5r8t1k:1"], tasks: [] },
          { id: 3, title: "Audit log viewer", status: "ready", assignee: "sam", tags: ["frontend", "data"], updated: "May 25", depends_on: ["atlas:q5r8t1k:1"], tasks: [] },
        ],
      },
      {
        id: "backlog",
        title: "Backlog",
        accent: "slate",
        stories: [
          { id: 1, title: "Usage dashboard", status: "ready", assignee: "maya", tags: ["frontend"], updated: "May 11", depends_on: [], tasks: [] },
        ],
      },
    ],
  },
];

// Item bodies (markdown-ish plain text), keyed by fully-qualified id (no #).
// Epics + stories carry descriptions; tasks are intentionally terse.
const BODIES = {
  // ---- Helios · Onboarding 2.0 ----
  "helios:k7m2x9p": "Rebuild the first-run experience so a new org reaches its first dashboard in under five minutes. Covers email verification, the welcome flow, workspace creation, and the analytics needed to measure activation.",
  "helios:k7m2x9p:1": "Require a verified email before an account becomes active. Sends a signed token on signup, handles expiry, and exposes a resend path. Gates everything downstream in the onboarding funnel.",
  "helios:k7m2x9p:2": "A guided, multi-step welcome that introduces core concepts and collects the minimum to personalize the workspace. Replaces the old single-screen form. Progress persists if the agent drops off mid-flow.",
  "helios:k7m2x9p:3": "Let the first user name their workspace, invite teammates, and assign roles. Depends on the welcome flow handing off a partially-built org.",
  "helios:k7m2x9p:4": "Seed a fresh workspace with representative dashboard fixtures so the product never feels empty on first load.",
  "helios:k7m2x9p:5": "Instrument the funnel end to end. Blocked until the stepper and workspace steps emit stable event names.",
  // ---- Helios · Billing & Invoicing ----
  "helios:b3n8q4r": "Stand up subscription billing on Stripe: plan changes, invoices, proration, and dunning. Must reconcile cleanly with the existing entitlements service.",
  "helios:b3n8q4r:1": "Two-way sync between Stripe subscriptions and internal plan state via webhooks, with reconciliation for out-of-band plan changes.",
  "helios:b3n8q4r:2": "The in-app surface for upgrading or downgrading a plan, including a clear diff of what changes and when.",
  "helios:b3n8q4r:3": "Generate branded PDF invoices on demand and on each billing cycle.",
  "helios:b3n8q4r:4": "Compute prorated charges and credits when a plan changes mid-cycle. Blocked on subscription sync landing first.",
  "helios:b3n8q4r:5": "Automated email sequence for failed payments before an account is suspended.",
  // ---- Helios · Realtime Notifications ----
  "helios:t6w1c5h": "A realtime layer for in-app and push notifications, built on an authenticated WebSocket gateway.",
  "helios:t6w1c5h:1": "The connection backbone: a managed WebSocket gateway with an auth handshake and reconnection handling.",
  "helios:t6w1c5h:2": "A lightweight, accessible toast system for surfacing realtime events in the app.",
  "helios:t6w1c5h:3": "Per-channel notification preferences so agents control what reaches them.",
  "helios:t6w1c5h:4": "Deliver notifications to mobile via push when a session is offline.",
  "helios:backlog": "Unscheduled work for Helios — triaged but not yet committed to a milestone.",
  "helios:backlog:1": "A full pass to support dark mode across the analytics surface.",
  "helios:backlog:2": "Throttle large CSV exports to protect the warehouse from runaway queries.",
  // ---- Orbit ----
  "orbit:m9k4p2x": "Make the mobile companion fully usable offline, with a local cache and deterministic conflict resolution on reconnect.",
  "orbit:m9k4p2x:1": "An on-device cache layer that mirrors the subset of data the app needs offline.",
  "orbit:m9k4p2x:2": "Resolve divergent edits when a device reconnects. Blocked until the cache layer defines its write log.",
  "orbit:m9k4p2x:3": "A clear indicator of sync state — offline, syncing, or up to date.",
  "orbit:w2h7n3q": "Wire up push notifications and deep links so a tap lands on the right screen.",
  "orbit:w2h7n3q:1": "Register devices with APNs and FCM and route payloads to the app.",
  "orbit:w2h7n3q:2": "Map notification and external URLs to in-app destinations.",
  "orbit:backlog": "Unscheduled work for Orbit.",
  "orbit:backlog:1": "Unlock the app with Face ID / fingerprint.",
  // ---- Atlas ----
  "atlas:q5r8t1k": "Role-based access control for the admin console: a permission model, a role editor, and an audit trail.",
  "atlas:q5r8t1k:1": "The underlying permission model — roles, scopes, and how they compose.",
  "atlas:q5r8t1k:2": "A UI for creating and editing roles. Depends on the permission model.",
  "atlas:q5r8t1k:3": "A searchable viewer for the audit log. Depends on the permission model emitting events.",
  "atlas:backlog": "Unscheduled work for Atlas.",
  "atlas:backlog:1": "A usage dashboard for account admins.",
};

window.LOOM = { STATUSES, PEOPLE, PROJECTS, BODIES };
