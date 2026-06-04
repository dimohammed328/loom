# loom-app web

Bun-powered TypeScript project housing the loom SDK, HTTP server, and React frontend.

## Layout

```
web/
├── lib/         TypeScript SDK — types and client logic
├── server/      Bun HTTP server (Bun.serve)
├── frontend/    React application entry point
├── package.json Bun scripts and dependencies
└── tsconfig.json Strict TypeScript config with path aliases
```

### Path aliases (tsconfig.json)

| Alias        | Resolves to   |
|--------------|---------------|
| `@lib/*`     | `lib/*`       |
| `@server/*`  | `server/*`    |
| `@frontend/*`| `frontend/*`  |

## Run commands

| Command            | Description                          |
|--------------------|--------------------------------------|
| `bun run dev`      | Start the server in development mode |
| `bun run start`    | Start the server                     |
| `bun test`         | Run all tests                        |
| `bun run typecheck`| Type-check without emitting files    |

## Prerequisites

- [Bun](https://bun.sh) >= 1.0

Install dependencies:

```bash
bun install
```
