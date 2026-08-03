# Business E2E (black-box)

Node Supervisor + Test MCP + (phase-3) Settings Probe + Fake/OpenCode Driver + Skills + Node Oracle.

- Capability parts: [`docs/业务测试.md` §0.1](../../docs/业务测试.md#01-两段式业务验收约定)
- Run phases + providers: [`docs/业务测试.md` §0.2](../../docs/业务测试.md#02-三阶段跑测与-providers-cli)
- Operator guide (architecture, phase-3 evidence, i18n):
  [`docs/business-testing/04-脚本使用与三语言架构.md`](../../docs/business-testing/04-脚本使用与三语言架构.md)

## Phases

| Phase | `--part`       | Cases                                                                                    | Evidence (summary)                                                                                               |
| ----- | -------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1     | `conversation` | `chat-basic`, `chat-create-html`, `chat-image-attachment`                                | Turn + (html) file oracle; image attachment read in ordinary chat. Drivers/skills may clarify up to 3 follow-ups (4 turns total) if the agent asks for details. |
| 2     | `draft-job`    | `design-draft` (aliases: `notes-search`, …)                                              | Chat clarify-loop (≤4 turns) then Design `/api/drafts` smoke: create → abilities → execution profile → confirm                                     |
| 3     | `settings-mcp` | `settings-mcp-probe`                                                                     | Settings API round-trip + reserved reject + probe self-check (`PROBE_OK_*`). **Not** “SUT role called probe” yet |

Image chat cases upload the fixture as neutral `attachment.png`, never leak `Dream`/`1000`/`Cats` in prompts/titles, and match the contiguous phrase `Dream of 1000 Cats` (NFKC, case/whitespace insensitive). create_task-era draft→job e2e case IDs were removed in architecture 03; deeper Design/Execution coverage lives in unit tests.

**Two MCP surfaces:** Test MCP = outer driver. Settings Probe (`business-e2e-probe`) = user MCP registered via `PUT /api/settings/mcp`. Do not confuse them.

```bash
npm run build:server

npm run business:e2e:list
npm run business:e2e:list -- --lang en

npm run business:e2e:conversation
npm run business:e2e:chat-html
npm run business:e2e:chat-image
npm run business:e2e:draft-chat-image
npm run business:e2e:draft-job
npm run business:e2e:draft-ref-path
npm run business:e2e:notes-search
npm run business:e2e:settings-mcp
npm run business:e2e:both
npm run business:e2e:phases

npm run business:e2e -- --providers opencode --part conversation,draft-job,settings-mcp
npm run business:e2e -- --providers claude --part conversation,draft-job,settings-mcp
npm run business:e2e -- --providers codex --part conversation,draft-job,settings-mcp
npm run business:e2e -- --providers cursor,opencode --case settings-mcp-probe
npm run business:e2e -- --providers all --suite both --lang en
```

`--providers` / `--profile` selects what to run (`all` = every supported provider). No `BUSINESS_ALLOW_*` env.

Planner / slice / milestone verifier cores for draft→job cases come from the **per-draft** `executionConfig` (Test MCP `codetask_update_draft_execution_config`), not from global `/api/settings/agent-defaults`.

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

Each `--providers` slot fixes all SUT roles to the selected provider (or use the legacy `--profile` flag). G8 is the provider-selected full-chain probe.
