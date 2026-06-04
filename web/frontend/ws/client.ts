/**
 * WebSocket client with exponential-backoff reconnect.
 *
 * Usage:
 *   const client = createWsClient({
 *     url: "/ws",
 *     onMessage: (payload) => { ... },
 *   });
 *   client.connect();
 *   // later:
 *   client.disconnect();
 *
 * Design notes:
 * - The browser WebSocket constructor takes a full URL; we convert a path
 *   to an absolute ws:// / wss:// URL using window.location at connect time.
 * - Reconnect is attempted on every close event UNLESS disconnect() was
 *   called explicitly by the consumer (intentional close).
 * - Backoff is exponential, capped at maxMs (default 30 s).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parsed WS message — either a full item update or a tombstone. */
export interface WsPayload {
  qid: string;
  /** Present and true only for tombstone (deleted) events. */
  deleted?: true;
  type?: string;
  title?: string;
  status?: string | null;
  assignee?: string | null;
  branch?: string | null;
  pr_url?: string | null;
  tags?: string[];
  archived?: boolean;
}

export interface WsClientConfig {
  /** WebSocket path or full URL, e.g. "/ws" or "wss://example.com/ws". */
  url: string;
  /** Called for every successfully parsed message. */
  onMessage: (payload: WsPayload) => void;
  /** Base reconnect delay in ms. Defaults to 500. */
  baseMs?: number;
  /** Maximum reconnect delay in ms. Defaults to 30000. */
  maxMs?: number;
}

export interface WsClient {
  /** Open (or re-open) the connection. */
  connect(): void;
  /** Close and disable automatic reconnect. */
  disconnect(): void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compute exponential-backoff delay.
 *
 * @param attempt - 0-based reconnect attempt index.
 * @param opts - `baseMs` and `maxMs` caps.
 * @returns delay in milliseconds, capped at `maxMs`.
 */
export function computeBackoffMs(
  attempt: number,
  opts: { baseMs: number; maxMs: number },
): number {
  const raw = opts.baseMs * Math.pow(2, attempt);
  return Math.min(raw, opts.maxMs);
}

/**
 * Parse a raw WebSocket message string into a WsPayload.
 *
 * Returns null when the string is not valid JSON, not an object, or missing
 * the mandatory `qid` field.
 */
export function parseWsPayload(raw: string): WsPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["qid"] !== "string") {
    return null;
  }
  return obj as unknown as WsPayload;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a managed WebSocket client with auto-reconnect.
 *
 * The client is NOT connected on creation — call `.connect()` to start.
 */
export function createWsClient(cfg: WsClientConfig): WsClient {
  const baseMs = cfg.baseMs ?? 500;
  const maxMs = cfg.maxMs ?? 30_000;

  let ws: WebSocket | null = null;
  let attempt = 0;
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function resolveUrl(): string {
    const raw = cfg.url;
    if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw;
    // Convert path to absolute ws URL using current origin.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${raw}`;
  }

  function open(): void {
    if (ws) {
      // Close any existing socket silently before re-opening.
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    const socket = new WebSocket(resolveUrl());
    ws = socket;

    socket.onopen = () => {
      attempt = 0; // reset backoff on successful connect
    };

    socket.onmessage = (ev: MessageEvent<string>) => {
      const payload = parseWsPayload(ev.data);
      if (payload) {
        cfg.onMessage(payload);
      }
    };

    socket.onerror = () => {
      // onerror is always followed by onclose; let onclose handle reconnect.
    };

    socket.onclose = () => {
      ws = null;
      if (intentionalClose) return;
      const delay = computeBackoffMs(attempt, { baseMs, maxMs });
      attempt += 1;
      reconnectTimer = setTimeout(open, delay);
    };
  }

  return {
    connect(): void {
      intentionalClose = false;
      open();
    },
    disconnect(): void {
      intentionalClose = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
    },
  };
}
