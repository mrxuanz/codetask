# Business E2E (black-box)

Node Supervisor + Test MCP + OpenCode/Fake Driver + Skills + Node Oracle.

Canonical organization: **two acceptance parts** — see
[`docs/业务测试.md` §0.1](../../docs/业务测试.md#01-两段式业务验收约定).

| Part | Meaning | Default depth case |
| ---- | ------- | ------------------ |
| **conversation** | Normal chat system | `chat-basic` |
| **draft-job** | Draft → execution tree → job (one chain) | `notes-search` |

Do **not** use `G3` / `G6-001` style names in daily scripts. Prefer friendly slugs and `--part`.

```bash
npm run build:server

# List friendly names
npm run business:e2e:list

# Part A — normal conversation
npm run business:e2e:conversation

# Part B — draft → plan → job (Notes Search)
npm run business:e2e:draft-job
# same:
npm run business:e2e:notes-search

# Both parts
npm run business:e2e:both

# Smoke (bootstrap + chat-basic)
npm run business:e2e:smoke

# Explicit flags
npm run business:e2e -- --profile fixed-opencode --case notes-search
npm run business:e2e -- --profile fixed-opencode --part conversation,draft-job
npm run business:e2e -- --profile fixed-opencode --suite both

# Keep previous .runtime for debugging
npm run business:e2e:notes-search -- --keep-runtime
```

Legacy `--gate G4` / `--case G6-001` still work but print a deprecation warning.

Each run **always** resets test state at startup:

- kill leftover OpenCode / case-worker / prior `.runtime` processes
- **clear test databases** (`app.db` / `*.db*` under business-e2e runtime)
- delete `tests/business-e2e/.runtime/` (and `.tmp` / `.cache` if present)
- recreate a clean `.runtime`; the dedicated Server then boots on a **fresh empty DB**

`--keep-runtime` no longer skips DB/runtime wipe (copy artifacts out before rerun if you need them).

Run end banner: `********* SUCCESS *********` or `########## FAILURE #####`.

Default: one fixed SDK/ACP for conversation + control-plane planner/slice/milestone
(`--profile fixed-opencode`). Provider switch / mixed-job is later (≈ G8), not the default path.

Progress notes:

- Part B depth representative: **notes-search** (human-like draft collect → confirm → poll plan → confirm_plan → job → file oracle)
- Fake/scripted probes remain available under legacy gates; they do not replace Part A/B depth

Runtime artifacts (gitignored): `tests/business-e2e/.runtime/runs/<runId>/`.
