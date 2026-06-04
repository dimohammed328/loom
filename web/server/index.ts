// loom-app server — Bun HTTP server entry point

import { createApp } from "./app";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const ROOT = process.env["LOOM_DIR"];

const server = createApp(ROOT, PORT);
console.log(`loom-app listening on http://localhost:${server.port}`);
