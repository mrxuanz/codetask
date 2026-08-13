# Changelog

All notable changes are documented here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versions once a stable
release line begins.

## Unreleased

### Fixed

- Upgraded Electron to 43.4.0 to remove the vulnerable `extract-zip` dependency chain.
- Third-party npm license inventory generation now resolves optional-platform packages from the
  lockfile and fails closed on unknown licenses.
- Packaged desktop Service discovery and first-run desktop account setup.
- Conversation restart recovery, realtime delta delivery, resync, cancellation, and auth expiry.
- Execution dependency mapping, startup recovery, outbox delivery, planning concurrency, reference
  projection, and sandbox parity.

### Changed

- Added npm audit, cargo-deny, CodeQL, dependency review, secret scanning, and OpenSSF Scorecard
  safeguards.
- Native workspace crates are explicitly non-publishable, internal path dependencies are versioned,
  and Electron packages retain only the product's supported locales.
- Browser-safe Provider metadata now lives in `@codetask/provider-spec`.
- Service development entry points no longer depend on test helpers.
