# Security Policy

## Supported Versions

Security fixes are applied to the latest code on `main`.

This project includes:

- local authentication and session handling
- provider credentials and token bridges
- native sandbox helpers
- filesystem and process execution paths

Treat all security-impacting changes as sensitive until a fix is available.

## Sandbox Threat Model

The OS sandbox enforces filesystem whitelisting and process isolation with a
fail-closed launcher and policy attestation. **Outbound network egress from
sandboxed tasks is intentionally not restricted**: agent CLIs need internet
access for model APIs, web research, and package installs. Consequently, data
exfiltration over the network by code running inside the sandbox is a known,
accepted limitation — not a reportable sandbox escape. Reports about bypassing
the filesystem or process boundary are always in scope.

## Reporting a Vulnerability

Please do not open a public issue for an unpatched vulnerability.

Preferred reporting order:

1. Use GitHub's private vulnerability reporting for this repository, if enabled.
2. If private reporting is not enabled, contact the maintainer through the repository owner's GitHub profile and include `SECURITY` in the subject or first line.

Include as much of the following as you can:

- affected commit, tag, or branch
- environment details: OS, Node version, Rust toolchain, provider used
- reproduction steps
- expected impact
- proof-of-concept or logs, if safe to share

Particularly important categories for this repository:

- sandbox escape or sandbox policy bypass
- unauthorized filesystem read/write
- command injection
- auth/session bypass
- credential or token disclosure
- privilege escalation in native helpers

## Handling Expectations

Target response times:

- acknowledgement within 7 days
- follow-up status update within 14 days if reproduction succeeds

Public disclosure should wait until a fix or mitigation is available.
