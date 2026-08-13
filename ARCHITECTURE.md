# Architecture

codetask is a local-first application with three runtime workspaces, one test workspace, and a set
of internal TypeScript packages. Every workspace owns its `package.json` and `tsconfig.json`; root
configuration provides shared compiler defaults, repository orchestration, and final product
bundling. Internal packages export TypeScript sources and are not independently published.

## Ownership map

| Area                             | Owns                                                            | Must not own                               |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `apps/web`                       | Browser UI, API clients, realtime reducers                      | Node APIs, Provider SDKs, process spawning |
| `apps/desktop`                   | Electron window policy and Service child supervision            | Business/runtime packages                  |
| `apps/service`                   | Hono process, HTTP host, storage setup and Node adapters        | Electron APIs                              |
| `tests`                          | Test runners, fixtures and repository verification              | Production runtime entry points            |
| `src/server`                     | Service composition, auth, filesystem and sandbox adapters      | Browser UI                                 |
| `packages/contracts`             | Wire DTOs, schemas, shared pure contracts                       | Database or host APIs                      |
| `packages/provider-spec`         | Browser-safe Provider metadata and settings shapes              | SDKs, subprocesses, host identity          |
| `packages/provider-runtime-node` | Provider SDK/CLI drivers and host integration                   | Renderer dependencies                      |
| `packages/server-core`           | Hono Service modules: Design, Conversation, Execution, Realtime | Electron APIs                              |
| `packages/database`              | SQLite schema and ordered migrations                            | HTTP/UI behavior                           |
| `packages/agent-runtime`         | Provider-independent turn lifecycle                             | Concrete Provider SDKs                     |

## Runtime flow

1. Electron supervises a loopback Service child; desktop and headless entries boot the same Hono application.
2. Authentication establishes an HttpOnly session and signed CSRF token.
3. Conversation turns and planning requests enter `server-core` through HTTP ports.
4. `agent-runtime` selects a capability profile; Provider drivers execute the turn.
5. Planner, task, and verifier turns run in the outer OS sandbox. Task turns alone receive
   workspace write access; Provider identity/config remains read-only for untrusted turns.
6. SQLite outboxes persist state changes before Realtime publishes them over SSE.

## Dependency rules

- `packages/**` must not import `src/**`.
- `apps/web` may depend on `contracts` and `provider-spec`, never `provider-runtime-node`.
- `apps/desktop` may depend on Electron tooling and `service-bootstrap`, never business/runtime packages.
- `apps/service` must not import Electron.
- `tests` owns test-runner configuration; production workspaces must not depend on it.
- application and package code must not import `tests/**`.
- `server-core` owns the Hono API surface; its domain/application internals should keep Hono inside
  the HTTP adapter layer. No Service or domain code may import Electron.

These constraints are executable in `tests/architecture` and should be updated with any deliberate
boundary change.

## Data and concurrency

SQLite is the source of truth. State changes that must agree—such as an execution tree, its planning
run, and the session revision—are committed in one transaction. Optimistic revisions protect user
edits, fencing tokens reject stale planners, leases carry instance-unique owners, and startup
reconciliation converts interrupted work into explicit retryable or failed states.

## Package maturity

The Service workspace typechecks host adapters still located in `src/server` and `src/sandbox`.
Those directories remain migration areas rather than separate workspaces. Files
marked `@deprecated` are compatibility shims only. New code should import the owning workspace
listed above; shims can be removed after their callers migrate.
