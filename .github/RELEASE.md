# Release workflow

The Release workflow builds the Electron application and the ncc + Node SEA standalone
service natively on six targets:

- Linux x64 and ARM64
- macOS Intel x64 and Apple Silicon ARM64
- Windows x64 and ARM64

All CI and release jobs read Node `24` from `.node-version`. The major version is pinned
while `actions/setup-node` selects the newest available Node 24 LTS patch.

## Manual release

Run the workflow from the commit that should be released and enter a new `v*` tag. If
the tag already exists, it must point to that exact commit. The workflow intentionally
rejects an older tag that points elsewhere, because building current code under an old
source tag would make the release unverifiable.

For example, `v0.1.0-beta` points to a commit from before the release evidence and SEA
packaging scripts existed. Leave that tag unchanged and create a new tag such as
`v0.1.0-beta.1` from the current release-capable commit.

Publishing is allowed only after the test gate, all six native package smokes, all six
SEA service smokes, and the release evidence-chain verification pass.
