/**
 * SSE (Server-Sent Events) helpers.
 *
 * formatSseEvent  — serialize a payload object to the SSE wire format.
 * createSseResponse — create a streaming Response that registers a subscriber
 *                     on start and calls onCancel when the client disconnects.
 */

// ---------------------------------------------------------------------------
// formatSseEvent
// ---------------------------------------------------------------------------

/**
 * Serialize a payload object to the SSE event format.
 *
 * Output: `data: <json>\n\n`
 */
export function formatSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ---------------------------------------------------------------------------
// createSseResponse
// ---------------------------------------------------------------------------

/**
 * Create an SSE streaming Response.
 *
 * The `setup` callback receives a `send` function; call it to push a payload
 * to the client. When the client disconnects the stream is cancelled and
 * `onCancel` is called so the caller can unsubscribe from the broadcaster.
 *
 * An initial SSE comment line (`: keepalive`) is enqueued immediately so that
 * Bun flushes the response headers to the client without waiting for the first
 * real event.
 *
 * @param onCancel  Called when the underlying ReadableStream is cancelled.
 * @param setup     Optional: called synchronously with a `send` function that
 *                  pushes a formatted SSE frame into the stream. The caller
 *                  uses `send` inside a Broadcaster subscriber callback.
 */
export function createSseResponse(
  onCancel: () => void,
  setup?: (send: (payload: Record<string, unknown>) => void) => void,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      // Flush an initial comment so Bun sends the response headers immediately.
      ctrl.enqueue(encoder.encode(": keepalive\n\n"));

      const send = (payload: Record<string, unknown>) => {
        try {
          ctrl.enqueue(encoder.encode(formatSseEvent(payload)));
        } catch {
          // Stream already closed; ignore.
        }
      };
      if (setup) setup(send);
    },
    cancel() {
      onCancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
