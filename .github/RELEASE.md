# Release workflow

The Release workflow builds the Electron application and the ncc + Node SEA standalone
service natively on six targets:

- Linux AMD64 and ARM64
- macOS AMD64 (Intel) and ARM64 (Apple Silicon)
- Windows AMD64 and ARM64

Public artifact names use only the operating system and architecture, for example
`codetask-0.1.0-beta.1-linux-amd64.AppImage` and
`codetask-server-0.1.0-beta.1-windows-arm64.tar.gz`. GitHub runner image labels such as
`ubuntu-24.04` are not included in job display names or published filenames.

All CI and release jobs read the exact Node version from `.node-version`; Rust uses the exact
toolchain in `rust-toolchain.toml`. This keeps native ABI and evidence manifests reproducible
across all target runners.

## Manual release

Run the workflow from the commit that should be released and enter a new `v*` tag such as
`v0.1.0-beta.1`. If the tag already exists, it must point to that exact commit. The workflow
intentionally rejects an older tag that points elsewhere, because building current code
under an old source tag would make the release unverifiable.

Publishing is allowed only after the test gate, all six native package smokes, all six
SEA service smokes, and the release evidence-chain verification pass.

Public macOS and Windows desktop builds are required to be signed. Configure repository secrets
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `WIN_CSC_LINK`, and `WIN_CSC_KEY_PASSWORD`. macOS
notarization additionally requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
The release workflow fails before packaging a public artifact when the target's credentials are
missing; ordinary pull-request builds remain unsigned.

The standalone SEA service is built and smoke-tested on all six targets, but only Linux SEA
archives are attached to the public GitHub Release. macOS and Windows SEA archives remain
unpublished until their standalone Developer ID/Authenticode signing pipelines are implemented.

GitHub Release attachments include uniquely named desktop installers, Linux SEA archives, and
`legacy-release-report.json`. Per-platform evidence logs and manifests stay on workflow
artifacts (`release-evidence-bundle` and each platform build artifact), because Release
asset names are basename-only and would collide across the six targets.
