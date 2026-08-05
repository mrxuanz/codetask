# Contributing

## Before You Start

- Node.js 24.x
- Rust stable toolchain
- npm

Install dependencies:

```bash
npm install
```

Optional Electron download mirrors (not set by default):

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## Development

Common commands:

```bash
npm run dev
npm run dev:serve
npm run typecheck
npm run test:unit
npm run test:provider-contract
npm run test:sandbox:tdd
```

Native sandbox work may also require:

```bash
npm run build:sandbox
```

## Scope

Keep changes narrowly scoped to the problem being solved.

Good contributions usually:

- follow existing file and naming patterns
- keep refactors separate from behavior changes
- add focused tests for changed behavior
- preserve third-party notices and license references

Avoid mixing unrelated cleanup into the same change.

## Pull Requests

Before opening a pull request:

1. Run `npm run release:test-gate` for JavaScript/TypeScript changes.
2. Run the smallest focused test while iterating and report it in the PR.
3. If you touched sandbox or native code, run the relevant sandbox tests.
4. Update docs when behavior, setup, or operator workflow changed.

PR descriptions should explain:

- what changed
- why it changed
- how it was tested
- any platform limits or known follow-ups

## Third-Party Code

This repository adapts code derived from OpenAI Codex (`codex-rs`), forked as the `native/codeteam-*` crates, and also retains notices for some MIT-licensed components.

If your change touches:

- `native/codeteam-*`
- files carrying third-party attribution headers

then keep those notices intact and update [NOTICE](NOTICE) when attribution scope changes.

## Security

For vulnerabilities, do not use public issues first. Follow [SECURITY.md](SECURITY.md).
