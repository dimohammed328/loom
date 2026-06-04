/**
 * Bun.serve HTTP server with read-only GET endpoints and live-update WebSocket.
 *
 * Mirrors the route structure of src/loom_web/app.py:
 *   GET /api/health                      → { status: 'ok' }
 *   GET /api/projects                    → ProjectSummary[]
 *   GET /api/projects/{project}/tree     → TreeResponse
 *   GET /api/items/{qid:path}            → ItemDetail
 *   WS  /ws                              → ItemUpdate / ItemTombstone stream
 *   GET /*                               → React SPA (Bun fullstack HTML bundling)
 *
 * NotFound errors map to HTTP 404 with { detail: string }.
 *
 * Bun fullstack: importing index.html causes Bun to bundle main.tsx and all
 * CSS imports on the fly (with HMR in dev). The bundled page is served for all
 * non-API routes via the `routes["/*"]` wildcard, while API routes are matched
 * first via their explicit `/api/*` prefix handler.
 */

import { LoomGateway } from "./gateway";
import { serializeProject, serializeTree, serializeItemDetail } from "./serializers";
import { NotFound } from "../lib/errors";
import { Broadcaster, type Subscriber } from "./broadcaster";
import { UpdatesWorker } from "./updates";
import indexHtml from "../frontend/index.html";

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

    // ---- Static routes ------------------------------------------------------
    // Bun evaluates routes before fetch. /api/* and /ws are handled inline;
    // /* catches all remaining paths and returns the bundled React SPA
    // (Bun bundles main.tsx → index.html on first request, with HMR in dev).
    routes: {
      // API routes — handled inline so they take priority over the SPA wildcard.
      "/api/health": (_req) => jsonResponse({ status: "ok" }),

      "/api/projects": async (_req) => {
        try {
          const projects = await gateway.listProjects();
          return jsonResponse(projects.map(serializeProject));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String((e as Error).message));
          throw e;
        }
      },

      "/api/projects/:project/tree": async (req) => {
        const project = (req as unknown as { params: Record<string, string> }).params["project"]!;
        try {
          const treeDict = await gateway.getTree(project);
          return jsonResponse(serializeTree(treeDict));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String((e as Error).message));
          throw e;
        }
      },

      // /api/items/* — qids contain colons (e.g. acme:abc:1:2) which are
      // not valid route param characters, so we handle the path manually.
      "/api/items/*": async (req) => {
        const url = new URL(req.url);
        const qid = url.pathname.slice("/api/items/".length);
        if (!qid) return notFound("qid required");
        try {
          const item = await gateway.getItemDetail(qid);
          const children = await gateway.getChildren(qid);
          return jsonResponse(serializeItemDetail(item, children));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String((e as Error).message));
          throw e;
        }
      },

      // SPA fallback — all non-API, non-WS paths serve the bundled React app.
      // Bun's HTML import causes index.html + main.tsx to be bundled; in dev
      // mode (bun dev) this includes HMR.
      "/*": indexHtml,
    },

    // ---- HTTP fetch ---------------------------------------------------------
    // Only handles WebSocket upgrade requests. All HTTP routes are handled via
    // the `routes` object above. Bun does not support WS upgrades inside
    // route handlers, so /ws must remain here.
    fetch(req: Request, server): Response | Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade<WsData>(req, { data: { subscriber: null! } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      // Fallback for unrouted requests (should not occur in practice).
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
