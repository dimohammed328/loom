/**
 * Bun.serve HTTP server with read-only GET endpoints and live-update WebSocket.
 *
 * Mirrors the route structure of src/loom_web/app.py:
 *   GET /api/health                      → { status: 'ok' }
 *   GET /api/projects                    → ProjectSummary[]
 *   GET /api/projects/{project}/tree     → TreeResponse
 *   GET /api/items/{qid:path}            → ItemDetail
 *   WS  /ws                              → ItemUpdate / ItemTombstone stream
 *
 * NotFound errors map to HTTP 404 with { detail: string }.
 */

import { LoomGateway } from "./gateway";
import { serializeProject, serializeTree, serializeItemDetail } from "./serializers";
import { NotFound } from "../lib/errors";
import { Broadcaster, type Subscriber } from "./broadcaster";
import { UpdatesWorker } from "./updates";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The return type of createApp — extends Bun.Server with live-update state. */
export interface LoomServer extends ReturnType<typeof Bun.serve> {
  broadcaster: Broadcaster;
  updatesWorker: UpdatesWorker;
}

/** Per-connection data stored in ws.data. */
interface WsData {
  subscriber: Subscriber;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(message: string): Response {
  return jsonResponse({ detail: message }, 404);
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

/**
 * Create and start a Bun HTTP server.
 *
 * @param root  Override $LOOM_DIR; undefined uses the environment-resolved path.
 * @param port  TCP port to listen on (default: 0 = OS-assigned).
 */
export function createApp(
  root?: string,
  port = 0
): LoomServer {
  const gateway = new LoomGateway(root);
  const broadcaster = new Broadcaster();

  const bunServer = Bun.serve<WsData, undefined>({
    port,

    // ---- WebSocket handlers -------------------------------------------------
    websocket: {
      open(ws) {
        const sub: Subscriber = (msg) => {
          ws.send(JSON.stringify(msg));
        };
        ws.data = { subscriber: sub };
        broadcaster.subscribe(sub);
      },
      message(_ws, _message) {
        // clients send nothing; ignore
      },
      close(ws) {
        if (ws.data?.subscriber) {
          broadcaster.unsubscribe(ws.data.subscriber);
        }
      },
    },

    // ---- HTTP fetch ---------------------------------------------------------
    async fetch(req: Request, server): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // ---- WS /ws -----------------------------------------------------------
      if (pathname === "/ws") {
        const upgraded = server.upgrade<WsData>(req, { data: { subscriber: null! } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // ---- GET /api/health --------------------------------------------------
      if (req.method === "GET" && pathname === "/api/health") {
        return jsonResponse({ status: "ok" });
      }

      // ---- GET /api/projects ------------------------------------------------
      if (req.method === "GET" && pathname === "/api/projects") {
        try {
          const projects = await gateway.listProjects();
          return jsonResponse(projects.map(serializeProject));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String(e.message));
          throw e;
        }
      }

      // ---- GET /api/projects/{project}/tree ---------------------------------
      const treeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tree$/);
      if (req.method === "GET" && treeMatch) {
        const project = treeMatch[1]!;
        try {
          const treeDict = await gateway.getTree(project);
          return jsonResponse(serializeTree(treeDict));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String(e.message));
          throw e;
        }
      }

      // ---- GET /api/items/{qid:path} ----------------------------------------
      // The qid may contain colons (e.g. acme:abc:1:2), so we strip the
      // prefix and treat the rest as the qid.
      const itemsPrefix = "/api/items/";
      if (req.method === "GET" && pathname.startsWith(itemsPrefix)) {
        const qid = pathname.slice(itemsPrefix.length);
        try {
          const item = await gateway.getItemDetail(qid);
          const children = await gateway.getChildren(qid);
          return jsonResponse(serializeItemDetail(item, children));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String(e.message));
          throw e;
        }
      }

      // ---- 404 for everything else ------------------------------------------
      return notFound("Not found");
    },
  });

  // Start the updates worker (fire-and-forget; runs until stop() is called).
  const updatesWorker = new UpdatesWorker({
    loom: gateway.loom,
    broadcaster,
  });
  updatesWorker.run();

  // Attach live-update state to the server object for tests and shutdown.
  const loomServer = bunServer as LoomServer;
  loomServer.broadcaster = broadcaster;
  loomServer.updatesWorker = updatesWorker;

  return loomServer;
}
