# Architecture

codetask is a local-first application with three hosts and a set of internal TypeScript packages.
The packages are source workspaces: their exports intentionally point to TypeScript and the root
build owns compilation and bundling. They are not independently published npm libraries.

## Ownership map

| Area                             | Owns                                                    | Must not own                               |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `apps/web`                       | Browser UI, API clients, realtime reducers              | Node APIs, Provider SDKs, process spawning |
| `apps/service`                   | Headless service entry                                  | Business logic                             |
| `src/main`                       | Electron host and Service child lifecycle               | Design, Conversation, or Execution rules   |
| `src/server`                     | Host composition, auth, filesystem and sandbox adapters | Browser UI                                 |
| `packages/contracts`             | Wire DTOs, schemas, shared pure contracts               | Database or host APIs                      |
| `packages/provider-spec`         | Browser-safe Provider metadata and settings shapes      | SDKs, subprocesses, host identity          |
| `packages/provider-runtime-node` | Provider SDK/CLI drivers and host integration           | Renderer dependencies                      |
| `packages/server-core`           | Design, Conversation, Execution, and Realtime modules   | Electron APIs                              |
| `packages/database`              | SQLite schema and ordered migrations                    | HTTP/UI behavior                           |
| `packages/agent-runtime`         | Provider-independent turn lifecycle                     | Concrete Provider SDKs                     |

## Runtime flow

1. Electron or the headless Service selects storage and boots the Hono application.
2. Authentication establishes an HttpOnly session and signed CSRF token.
3. Conversation turns and planning requests enter `server-core` through HTTP ports.
4. `agent-runtime` selects a capability profile; Provider drivers execute the turn.
5. Planner, task, and verifier turns run in the outer OS sandbox. Task turns alone receive
   workspace write access; Provider identity/config remains read-only for untrusted turns.
6. SQLite outboxes persist state changes before Realtime publishes them over SSE.

## Dependency rules

- `packages/**` must not import `src/**`.
- `apps/web` may depend on `contracts` and `provider-spec`, never `provider-runtime-node`.
- application and package code must not import `tests/**`.
- host composition may adapt packages, but domain packages must not know Electron or Hono host
  details.

These constraints are executable in `tests/architecture` and should be updated with any deliberate
boundary change.

## Data and concurrency

SQLite is the source of truth. State changes that must agree—such as an execution tree, its planning
run, and the session revision—are committed in one transaction. Optimistic revisions protect user
edits, fencing tokens reject stale planners, leases carry instance-unique owners, and startup
reconciliation converts interrupted work into explicit retryable or failed states.

## Package maturity

The repository is still moving host adapters out of `src/shared` and `src/server`. Files marked
`@deprecated` are compatibility shims only. New code should import the owning workspace listed
above; shims can be removed after their callers migrate.
