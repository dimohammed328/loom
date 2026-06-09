/**
 * SSE (Server-Sent Events) client.
 *
 * Usage:
 *   const client = createSseClient({
 *     url: "/api/events",
 *     onMessage: (payload) => { ... },
 *   });
 *   client.connect();
 *   // later:
 *   client.disconnect();
 *
 * Design notes:
 * - `EventSource` handles automatic reconnection with browser-managed backoff.
 * - SSE comments (lines starting with `:`) are ignored automatically by the
 *   browser EventSource — only `data:` lines trigger the `message` event.
 * - The payload shape is identical to the former WsPayload so existing
 *   store reducers (applyWsPayload / itemsReducer) work without changes.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parsed SSE message — either a full item update or a tombstone. */
export interface SsePayload {
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

export interface SseClientConfig {
  /** SSE endpoint path or full URL, e.g. "/api/events". */
  url: string;
  /** Called for every successfully parsed message. */
  onMessage: (payload: SsePayload) => void;
}

export interface SseClient {
  /** Open the SSE connection. */
  connect(): void;
  /** Close the connection (no automatic reconnect after this). */
  disconnect(): void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE data string into an SsePayload.
 *
 * Returns null when the string is not valid JSON, not an object, or missing
 * the mandatory `qid` field.
 */
export function parseSsePayload(raw: string): SsePayload | null {
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
  return obj as unknown as SsePayload;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a managed SSE client.
 *
 * The client is NOT connected on creation — call `.connect()` to start.
 * Reconnection is handled automatically by the browser's EventSource.
 */
export function createSseClient(cfg: SseClientConfig): SseClient {
  let es: EventSource | null = null;

  return {
    connect(): void {
      if (es) return; // already connected
      es = new EventSource(cfg.url);
      es.onmessage = (ev: MessageEvent<string>) => {
        const payload = parseSsePayload(ev.data);
        if (payload) {
          cfg.onMessage(payload);
        }
      };
      es.onerror = () => {
        // EventSource auto-reconnects on error; no action needed.
      };
    },
    disconnect(): void {
      if (es) {
        es.close();
        es = null;
      }
    },
  };
}
