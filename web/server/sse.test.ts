/**
 * Tests for SSE serialization helper.
 *
 * formatSseEvent turns a payload object into the SSE wire format:
 *   data: <json>\n\n
 */

import { describe, test, expect } from "bun:test";
import { formatSseEvent, createSseResponse } from "./sse";

describe("formatSseEvent", () => {
  test("produces data: <json>\\n\\n", () => {
    const payload = { qid: "proj:abc:1", type: "task" };
    const result = formatSseEvent(payload);
    expect(result).toBe(`data: ${JSON.stringify(payload)}\n\n`);
  });

  test("serializes complex payload", () => {
    const payload = {
      qid: "proj:abc23:1",
      type: "task",
      title: "Do thing",
      status: "in_progress",
      assignee: null,
      branch: null,
      pr_url: null,
      tags: ["backend"],
      archived: false,
    };
    const result = formatSseEvent(payload);
    expect(result).toStartWith("data: ");
    expect(result).toEndWith("\n\n");
    const parsed = JSON.parse(result.slice("data: ".length).trim());
    expect(parsed).toEqual(payload);
  });

  test("serializes tombstone payload", () => {
    const payload = { qid: "proj:abc:1", deleted: true };
    const result = formatSseEvent(payload);
    expect(result).toBe(`data: ${JSON.stringify(payload)}\n\n`);
  });
});

describe("createSseResponse", () => {
  test("returns a Response with text/event-stream content type", () => {
    const resp = createSseResponse(() => {});
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
  });

  test("sets Cache-Control: no-cache", () => {
    const resp = createSseResponse(() => {});
    expect(resp.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("sets Connection: keep-alive", () => {
    const resp = createSseResponse(() => {});
    expect(resp.headers.get("Connection")).toBe("keep-alive");
  });

  test("calls onCancel when stream is cancelled", async () => {
    let cancelled = false;
    const resp = createSseResponse(() => {
      cancelled = true;
    });
    // Cancel the body reader
    await resp.body!.cancel();
    expect(cancelled).toBe(true);
  });
});
