# Changelog

All notable changes are documented here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versions once a stable
release line begins.

## Unreleased

### Fixed

- Packaged desktop Service discovery and first-run desktop account setup.
- Conversation restart recovery, realtime delta delivery, resync, cancellation, and auth expiry.
- Execution dependency mapping, startup recovery, outbox delivery, planning concurrency, reference
  projection, and sandbox parity.

### Changed

- Browser-safe Provider metadata now lives in `@codetask/provider-spec`.
- Service development entry points no longer depend on test helpers.
