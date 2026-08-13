# Business E2E (black-box)

Node Supervisor + Test MCP + (phase-3) Settings Probe + scripted/SDK/ACP operator + Skills + Node Oracle.

- Acceptance layers, run phases, Providers, and operator guide:
  [`docs/testing/business-e2e.md`](../../docs/testing/business-e2e.md)

## Phases

| Phase | `--part`       | Cases                                                     | Evidence (summary)                                                                                                                                              |
| ----- | -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `conversation` | `chat-basic`, `chat-create-html`, `chat-image-attachment` | Turn + (html) file oracle; image attachment read in ordinary chat. Drivers/skills may clarify up to 3 follow-ups (4 turns total) if the agent asks for details. |
| 2     | `design`       | `design-draft-confirm`                                    | Chat clarify-loop (≤4 turns) then Design `/api/drafts`: create → abilities → execution profile → confirm. This case does not claim to publish or execute a job. |
| 3     | `settings-mcp` | `settings-mcp-probe`                                      | Settings API round-trip + reserved reject + probe self-check (`PROBE_OK_*`). **Not** “SUT role called probe” yet                                                |

Image chat cases upload the fixture as neutral `attachment.png`, never leak `Dream`/`1000`/`Cats` in prompts/titles, and match the contiguous phrase `Dream of 1000 Cats` (NFKC, case/whitespace insensitive). Retired create_task-era cases and numbered gate IDs were removed. The deterministic Hono lifecycle test in `tests/business-api-e2e/` covers conversation → Design planning → publish → Execution → verification → evidence through real HTTP and SQLite.

`--suite all` runs the complete black-box catalog: bootstrap + foundation + conversation + design + settings-mcp.
Supervisor/bootstrap cases (`driver: supervisor`, including Setup login) run **once** per server (`shared`); conversation/design/settings cases still multiply by `--providers`.

**Two MCP surfaces:** Test MCP = outer driver. Settings Probe (`business-e2e-probe`) = user MCP registered via `PUT /api/settings/mcp`. Do not confuse them.

```bash
npm run build:server

npm run business:e2e:list
npm run business:e2e:list -- --lang en

npm run business:e2e:conversation
npm run business:e2e:chat-html
npm run business:e2e:chat-image
npm run business:e2e:design
npm run business:e2e:settings-mcp
npm run business:e2e:both
npm run business:e2e:phases
npm run business:e2e:opencode-live

npm run business:e2e -- --operator opencode --providers opencode --case chat-basic
npm run business:e2e -- --operator codex --providers claude --case chat-basic
npm run business:e2e -- --operator claude --providers codex --case design-draft-confirm
npm run business:e2e -- --operator cursor --providers cursor --case chat-image-attachment
npm run business:e2e -- --operator fake --providers all --suite both --lang en
```

There are two independent selections:

- `--operator` (alias `--driver`) chooses the **outer actor** that operates cctask through the case-scoped Test MCP: `manifest`, `fake`, `opencode`, `codex`, `claude`, or `cursor`. Codex/Claude use their SDK adapters, Cursor uses ACP, and OpenCode uses the isolated local-server SDK harness.
- `--providers` / `--profile` chooses the **inside-cctask SUT core** used for conversation, planning, work, and verification (`all` = every supported provider).

For example, `--operator codex --providers claude` means “Codex acts like the human clicking/typing in cctask, while cctask sends the product conversation to Claude.” This can consume quota in both layers. Use `--operator fake` when only the inside-cctask provider should consume quota.

Without `--operator`, `manifest` preserves the catalog defaults: scripted cases use `fake`, and the live `chat-basic` case uses OpenCode. Because only OpenCode currently has test quota, merge CI runs deterministic E2E operator contracts plus the in-process Hono lifecycle with provider fakes; the scheduled live workflow explicitly runs `--operator opencode --providers opencode`. Configure the repository secret `OPENCODE_API_KEY` before enabling it. Manual workflow runs can choose one of the supported live scenarios.

The shared route table in `tests/helpers/hono-business-routes.ts` is imported by both the standalone E2E HTTP client and the deterministic Hono lifecycle test. When Hono business routes change, update that contract once and both acceptance layers compile/run against the new paths.

## Phase 3 registration (short)

1. Supervisor starts `probes/settings-mcp-probe.ts`.
2. Driver `GET` → `PUT` → `GET` `/api/settings/mcp` writing probe under `settings.roles.{conversation,task,verification}` × current core (not top-level role keys).
3. Assert probe name present; assert reserved name rejected; harness `tools/call` gets `PROBE_OK_*`.
4. Restore settings snapshot; `report_case_result`.

Evidence is emitted to the terminal. Per-run reports and mutable state live only in a unique OS
temporary directory and are removed after the final summary is printed.

## Runtime hygiene

Each run kills leftover E2E processes, removes stale E2E temp roots, then boots Server with a fresh
database under a newly created OS temporary directory. No runtime tree is created or copied into the
repository.

UI strings: `i18n/messages.ts` (`--lang` / `BUSINESS_E2E_LANG`).

Each `--providers` slot fixes all SUT roles to the selected provider (or use the compatibility `--profile` flag).
