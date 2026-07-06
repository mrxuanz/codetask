# Contributing

## Before You Start

- Node.js 22+
- Rust stable toolchain
- npm

Install dependencies:

```bash
npm install
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

1. Run `npm run typecheck`.
2. Run the smallest relevant test set for your change.
3. If you touched sandbox or native code, run the relevant sandbox tests.
4. Update docs when behavior, setup, or operator workflow changed.

PR descriptions should explain:

- what changed
- why it changed
- how it was tested
- any platform limits or known follow-ups

## Third-Party Code

This repository vendors and adapts code derived from OpenAI Codex (`codex-rs`) and also retains notices for some MIT-licensed components.

If your change touches:

- `native/vendor/codex-rs`
- `native/codeteam-*`
- files carrying third-party attribution headers

then keep those notices intact and update [NOTICE](NOTICE) when attribution scope changes.

## Security

For vulnerabilities, do not use public issues first. Follow [SECURITY.md](SECURITY.md).
