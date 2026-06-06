/**
 * Bun.serve HTTP server with read-only GET endpoints and SSE live-update stream.
 *
 * Mirrors the route structure of src/loom_web/app.py:
 *   GET /api/health                      → { status: 'ok' }
 *   GET /api/projects                    → ProjectSummary[]
 *   GET /api/projects/{project}/tree     → TreeResponse
 *   GET /api/items/{qid:path}            → ItemDetail
 *   GET /api/events                      → SSE stream of ItemUpdate / ItemTombstone
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
import { createSseResponse } from "./sse";
import indexHtml from "../frontend/index.html";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The return type of createApp — extends Bun.Server with live-update state. */
export interface LoomServer extends ReturnType<typeof Bun.serve> {
  broadcaster: Broadcaster;
  updatesWorker: UpdatesWorker;
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

  const bunServer = Bun.serve({
    port,
    // SSE connections are long-lived; disable the default idle timeout so Bun
    // does not close open event streams before the client disconnects.
    idleTimeout: 0,

    // ---- Static routes ------------------------------------------------------
    // Bun matches specific routes before wildcards, so /api/events takes
    // priority over /*. Specific routes also take priority over fetch().
    routes: {
      // API routes — handled inline so they take priority over the SPA wildcard.
      "/api/health": (_req: Request) => jsonResponse({ status: "ok" }),

      "/api/projects": async (_req: Request) => {
        try {
          const projects = await gateway.listProjects();
          return jsonResponse(projects.map(serializeProject));
        } catch (e) {
          if (e instanceof NotFound) return notFound(String((e as Error).message));
          throw e;
        }
      },

      "/api/projects/:project/tree": async (req: Request) => {
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
      "/api/items/*": async (req: Request) => {
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

      // SSE live-update stream — each GET registers a Broadcaster subscriber
      // that forwards payloads as `data: <json>\n\n` frames. The subscriber
      // is removed when the client disconnects (stream cancel).
      "/api/events": (_req: Request) => {
        let sub: Subscriber | null = null;
        return createSseResponse(
          () => {
            if (sub) broadcaster.unsubscribe(sub);
          },
          (send) => {
            sub = send;
            broadcaster.subscribe(sub);
          },
        );
      },

      // SPA fallback — all non-API paths serve the bundled React app.
      // Bun's HTML import causes index.html + main.tsx to be bundled; in dev
      // mode (bun dev) this includes HMR.
      "/*": indexHtml,
    },

    // ---- HTTP fetch ---------------------------------------------------------
    // Fallback for any request not matched by a route (should not occur).
    fetch(_req: Request): Response | Promise<Response> {
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
