# Business E2E (black-box)

Node Supervisor + Test MCP + (phase-3) Settings Probe + Fake/OpenCode Driver + Skills + Node Oracle.

- Capability parts: [`docs/业务测试.md` §0.1](../../docs/业务测试.md#01-两段式业务验收约定)
- Run phases + providers: [`docs/业务测试.md` §0.2](../../docs/业务测试.md#02-三阶段跑测与-providers-cli)
- Operator guide (architecture, phase-3 evidence, i18n):
  [`docs/business-testing/04-脚本使用与三语言架构.md`](../../docs/business-testing/04-脚本使用与三语言架构.md)

## Phases

| Phase | `--part`       | Cases                               | Evidence (summary)                                                                                               |
| ----- | -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1     | `conversation` | `chat-basic`, `chat-create-html`    | Turn + (html) file oracle                                                                                        |
| 2     | `draft-job`    | `notes-search`, `job-chat-readonly` | Plan/job + file oracle; readonly thicken in progress                                                             |
| 3     | `settings-mcp` | `settings-mcp-probe`                | Settings API round-trip + reserved reject + probe self-check (`PROBE_OK_*`). **Not** “SUT role called probe” yet |

**Two MCP surfaces:** Test MCP = outer driver. Settings Probe (`business-e2e-probe`) = user MCP registered via `PUT /api/settings/mcp`. Do not confuse them.

```bash
npm run build:server

npm run business:e2e:list
npm run business:e2e:list -- --lang en

npm run business:e2e:conversation
npm run business:e2e:chat-html
npm run business:e2e:draft-job
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

## Phase 3 registration (short)

1. Supervisor starts `probes/settings-mcp-probe.ts`.
2. Driver `GET` → `PUT` → `GET` `/api/settings/mcp` for roles `conversation` / `task` / `verification` × current core.
3. Assert probe name present; assert reserved name rejected; harness `tools/call` gets `PROBE_OK_*`.
4. Restore settings snapshot; `report_case_result`.

Artifacts: terminal `settings.mcp.*` lines + `.runtime/runs/<runId>/reports/`.

## Runtime hygiene

Each run kills leftover processes, clears test DBs, resets `tests/business-e2e/.runtime/`, boots Server on empty DB.

UI strings: `i18n/messages.ts` (`--lang` / `BUSINESS_E2E_LANG`).

Each `--providers` slot fixes all SUT roles to the selected provider (or use the legacy `--profile` flag). G8 is the provider-selected full-chain probe.
