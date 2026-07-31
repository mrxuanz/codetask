# codetask

Language docs:

- English (this file)
- [中文文档](docs/README.zh-CN.md)
- [日本語ドキュメント](docs/README.ja.md)

**Plan the work. Step away. Come back to review.**

codetask is a desktop AI task orchestration app for software delivery. You freeze a requirements draft, a strong model turns it into a Coding Plan (Milestone → Slice → Task), and practical agent CLIs execute those small tasks unattended in an OS sandbox — while you are offline. When you return, the Tasks UI shows progress, evidence, and failures so you can retry, patch, and fill gaps in chat.

![codetask Tasks view — job progress and Milestone / Slice / Task execution tree](docs/codetask-tasks-progress.png)

Supports **Codex**, **Claude Code**, **OpenCode**, and **Cursor CLI** as planners and workers. Run as a native **Electron** app or headless **server** mode in the browser.

## Problem It Solves

The traditional approach — one large prompt and let the agent run to completion — often fails on long requirements:

- Context rots; output drifts further from intent over time
- No mid-flight review; when you return, you may need to start over
- Planning and execution share the same model, making cost and quality hard to balance

codetask separates concerns: **you set direction, a strong model plans, practical models execute, you verify and patch on return**.

Typical workflow:

1. **Before leaving** — freeze a requirements draft in chat, confirm agent CLI choices, start the Planner to produce Milestone → Slice → Task plans
2. **While away** — the job queue runs tasks in dependency order inside an OS sandbox; Slice / Milestone verifiers run automatically
3. **After return** — review the progress tree, evidence, and failures in the UI; confirm plans node by node, retry blocked tasks, and chat to fill gaps

## Core Ideas

### Planning vs Execution (Control Plane)

| Phase              | Role                                    | Recommended strategy                         | Notes                                              |
| ------------------ | --------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Chat / draft       | `conversation`                          | Strong model + read-only                     | Clarify requirements; freeze REQUIREMENTS CONTRACT |
| Plan generation    | `planner`                               | Strong model + read-only                     | Register structured plans and task context via MCP |
| Task execution     | `task-worker`                           | Practical / economical model + sandbox write | Each Task has isolated context; ~10 min per task   |
| Stage verification | `slice-verifier` / `milestone-verifier` | Configurable                                 | Read-only verification + separate output directory |

Configure Planner / Verifier CLIs separately under **Settings → Control Plane**. Each ability in the draft can specify `recommendedCoreCode` for execution — strong model for planning, practical model for work.

### Coding Plan + SDK Execution (More Cost-Effective)

For long-running software delivery, driving agents through a **Coding Plan** is often more affordable than calling model APIs turn-by-turn in your own app: each Task stays focused, you reuse existing CLI/SDK subscriptions, and you avoid re-sending bloated context on every request.

codetask therefore uses **Agent SDKs / CLIs as the execution layer** — Codex SDK, Claude Agent SDK, OpenCode SDK, Cursor ACP — rather than embedding raw HTTP API calls.

For **small, one-off work**, regular **conversation** is enough — no Coding Plan or Job needed. Use the structured pipeline when the requirement is long enough to benefit from unattended execution.

### Small Tasks, Anti Context Rot (inspired by GSD)

```
Milestone
  └── Slice (demonstrable vertical increment)
        └── Task (single agent session, ~10 minutes)
```

Planner rules (see `src/server/planner/prompts.ts`):

- Prefer many small Tasks over a few giant ones mixing unrelated changes
- Each Task registers **self-contained** context via MCP (Read First / Files / Constraints / Do / Done When)
- Explicit `successCriteria`, `abilityCode`, `taskKind`, and dependencies
- UI supports node-by-node review, edit, and confirm before execution starts

### Sandbox Isolation (inspired by Codex)

Task Worker / Verifier run in an OS-level sandbox, inspired by [OpenAI Codex](https://github.com/openai/codex); native layer uses `native/vendor/codex-rs` and custom `codeteam-*` crates:

- **Planner / chat** — no outer OS sandbox; SDK/ACP layer is read-only
- **Task Worker** — workspace writable, host filesystem read-only, isolated `runtimeRoot`
- **Fail closed** — sandbox helper or policy failure terminates immediately; no fallback to plain `spawn()`

## Workflow

```
Draft chat → confirm REQUIREMENTS CONTRACT → Planner generates plan
    → review / edit / confirm nodes → start Job
        → Task Worker (sandbox) → Slice verify → Milestone verify
            → done / retry blocked → return and chat to fill gaps
```

1. **Draft** — Wizard guides freezing title, acceptance criteria, abilities, references
2. **Planning** — Planner Agent calls `register_task_context` + `register_plan` into SQLite
3. **Confirmation** — UI confirms each Milestone / Slice / Task
4. **Execution** — one running job per user; pause, resume, cancel, retry, and blocked recovery
5. **Verification** — Verifier checks per layer; failed tasks can be rerun individually

Data is pushed via **SSE** job snapshots; embedded **Hono** HTTP server serves the Renderer.

## Tech Stack

| Layer         | Technology                                                         |
| ------------- | ------------------------------------------------------------------ |
| Desktop shell | Electron, electron-vite                                            |
| Frontend      | Vue 3, Vue Router, Tailwind CSS, vue-i18n                          |
| Backend       | Hono, better-sqlite3, Drizzle ORM                                  |
| Agents        | @openai/codex-sdk, Claude Agent SDK, OpenCode SDK, Cursor ACP      |
| Sandbox       | Rust native (`native/codeteam-*`, Seatbelt / bwrap / Win32 helper) |

## Acknowledgements

- **GSD (Get Shit Done)** — Milestone / Slice / Task hierarchy, clear done criteria, small steps to avoid context rot
- **[OpenAI Codex](https://github.com/openai/codex)** — Sandbox isolation and OS helper patterns; native layer vendors `native/vendor/codex-rs`
- **[t3code](https://github.com/pingdotgg/t3code)** — Desktop UX reference: project / chat / task layering, multi-provider integration, streaming state

## Open Source Notice

This repository includes vendored and adapted sandbox-related code derived from the OpenAI Codex project, primarily under `native/vendor/codex-rs` and the corresponding `native/codeteam-*` crates.

- Upstream project: [openai/codex](https://github.com/openai/codex)
- Upstream component used here: `codex-rs`
- Upstream license for those components: Apache License 2.0
- Local attribution details: [NOTICE](NOTICE)

See `native/vendor/codex-rs/LICENSE` and `native/vendor/codex-rs/NOTICE` for the upstream license text and notice.

Additional third-party code notices remain in the affected source files for MIT-licensed reused components such as the Windows PTY helpers and absolute-path utility.

## License

Unless otherwise noted, this repository is licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Run Modes

codetask supports **two launch modes** that share the same embedded Hono backend, SQLite data store, and sandbox supervisor:

| Mode                   | Description                                               | Default bind     |
| ---------------------- | --------------------------------------------------------- | ---------------- |
| **Desktop** (default)  | Electron opens a native window and loads the local web UI | `127.0.0.1:3000` |
| **Server** (`--serve`) | Headless — no window; open the URL in any browser         | `0.0.0.0:8080`   |

```bash
# Desktop (default)
npm run dev

# Server / headless — remote access, WSL, headless Linux, browser-only workflow
npm run dev:serve

# Custom host/port (dev or packaged app)
electron . --serve --host 127.0.0.1 --port 9000

# Pure Node server — no Electron, DISPLAY, or Xvfb required
npm run build:server
npm run start:server -- --host 127.0.0.1 --port 8080 --data-dir ./data
```

Notes:

- In **server** mode, Electron skips GPU init (helpful on WSL / CI / headless hosts).
- When bound to `0.0.0.0`, other devices on the LAN can reach the UI at `http://<your-ip>:<port>`.
- Job execution, planner, and sandbox behavior are identical in both modes — only the shell differs.
- The dedicated Node entry is always server mode, so `--serve` is optional for `start:server`.

## Quick Start

### Requirements

- Node.js 24.x
- Rust toolchain (for sandbox native components)
- At least one Agent CLI installed and logged in: Codex, Claude Code, OpenCode, or Cursor CLI
- Windows / macOS / Linux (sandbox capabilities vary by platform)

### Install

```bash
npm install
```

### Development

```bash
# Desktop mode (default) — Electron window
npm run dev

# Server mode — headless, open in browser (see Run Modes above)
npm run dev:serve
```

### Build

```bash
# Windows (with sandbox)
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

Build sandbox native first:

```bash
npm run build:sandbox
```

### Test

```bash
npm run test:unit
npm run test:provider-contract
npm run test:sandbox:tdd      # native sandbox TDD (requires build:sandbox)
npm run test:sandbox
npm run typecheck
npm run test:ci               # typecheck + fast test suite
```
