# No credential copy on the NEW adapter path

NEW Provider adapters under `src/server/adapters/providers/**` must **not**
implement credential materialization or host sync.

## Forbidden in NEW adapters

| Pattern | Meaning |
| --- | --- |
| `runtime-copy` | Legacy auth mode that copies host credentials into runtime home |
| `copy-back` | Writing runtime credential snapshots back to the host |
| `materializeCredential` | Production helper that copies auth files into instance dirs |

Also forbidden (conceptually, even if not exact tokens): credential snapshot
branches, whole-HOME grants, and using materializers as a Preflight fallback.

## Required instead

1. Declare identity via `ProviderRuntimeProfile` (env / OS keyring / precise host paths).
2. Resolve paths with platform path resolvers (never `$HOME` / `USERPROFILE` wildcards).
3. Compile with `compileProfileToPolicyInput` → `credentialCopy: false`.
4. Use per-instance dirs for session / state / log / tmp / ipc.

## Deferred legacy deletion (T225 / T226 → Wave 10 / T314)

Production prepare paths under `provider-auth/bridge.ts` are **host-identity**
for all four providers (no materialize on prepare). Diagnose/contract helpers
`materializeCodexAuth` / `materializeOpencodeAuth` remain under
`provider-auth/materialize.ts` until unused. Remaining T314 work is true `.node` SandboxChild /
`launchSandboxedWorker` replace (R1 gateway wrap is done) — see
`docs/refactor/gates/t314-spawn-inventory.md`.

## Enforcement

`tests/core/providers/profile.test.ts` fails if any `.ts` / `.tsx` under
`src/server/adapters/providers/**` contains `runtime-copy`, `copy-back`, or
`materializeCredential`.
