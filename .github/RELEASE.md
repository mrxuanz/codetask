# Release workflow

The Release workflow builds the Electron application and the ncc + Node SEA standalone
service natively on six targets:

- Linux AMD64 and ARM64
- macOS AMD64 (Intel) and ARM64 (Apple Silicon)
- Windows AMD64 and ARM64

Public artifact names use only the operating system and architecture, for example
`codetask-0.1.0-beta-linux-amd64.AppImage` and
`codetask-server-0.1.0-beta-windows-arm64.tar.gz`. GitHub runner image labels such as
`ubuntu-24.04` are not included in job display names or published filenames.

All CI and release jobs read Node `24` from `.node-version`. The major version is pinned
while `actions/setup-node` selects the newest available Node 24 LTS patch.

## Manual release

Run the workflow from the commit that should be released and enter a new `v*` tag such as
`v0.1.0-beta`. If the tag already exists, it must point to that exact commit. The workflow
intentionally rejects an older tag that points elsewhere, because building current code
under an old source tag would make the release unverifiable.

Publishing is allowed only after the test gate, all six native package smokes, all six
SEA service smokes, and the release evidence-chain verification pass.
