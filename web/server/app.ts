/**
 * Bun.serve HTTP server with read-only GET endpoints.
 *
 * Mirrors the route structure of src/loom_web/app.py:
 *   GET /api/health                      → { status: 'ok' }
 *   GET /api/projects                    → ProjectSummary[]
 *   GET /api/projects/{project}/tree     → TreeResponse
 *   GET /api/items/{qid:path}            → ItemDetail
 *
 * NotFound errors map to HTTP 404 with { detail: string }.
 */

import { LoomGateway } from "./gateway";
import { serializeProject, serializeTree, serializeItemDetail } from "./serializers";
import { NotFound } from "../lib/errors";

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
): ReturnType<typeof Bun.serve> {
  const gateway = new LoomGateway(root);

  return Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;

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
}
