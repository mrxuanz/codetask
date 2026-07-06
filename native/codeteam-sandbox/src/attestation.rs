//! Shared sandbox attestation artifact + in-sandbox command wrappers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::protocol::SandboxEvidence;

pub const ATTESTATION_MARKER: &str = "__CODETASK_ATTEST__";
pub const ATTESTATION_ARTIFACT_NAME: &str = ".sandbox-attestation.json";
pub const ATTESTATION_EMITTER_SCRIPT: &str = "emit-sandbox-attestation.cjs";
#[cfg(windows)]
pub const ATTESTATION_LAUNCHER_SCRIPT: &str = "launch-sandbox-worker.cjs";

const EMITTER_SCRIPT_SOURCE: &str = r#"#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = process.env.CODETASK_ATTESTATION_FILE;
if (!path || !fs.existsSync(path)) process.exit(0);
let value;
try {
  value = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch {
  process.exit(0);
}
value.active = true;
value.sandbox_pid = process.pid;
process.stderr.write('__CODETASK_ATTEST__' + JSON.stringify(value) + '\n');
"#;

#[cfg(windows)]
const LAUNCHER_SCRIPT_SOURCE: &str = r#"#!/usr/bin/env node
'use strict';
require('./emit-sandbox-attestation.cjs');
const { spawnSync } = require('child_process');
const [command, ...args] = process.argv.slice(2);
if (!command) process.exit(1);
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true
});
process.exit(result.status == null ? 1 : result.status);
"#;

#[cfg(target_os = "macos")]
const UNIX_SHELL_PRELUDE: &str = r#"
if [ -n "${CODETASK_ATTESTATION_FILE:-}" ] && [ -f "$CODETASK_ATTESTATION_FILE" ]; then
  emitter="$(dirname "$CODETASK_ATTESTATION_FILE")/emit-sandbox-attestation.cjs"
  if [ -f "$emitter" ] && command -v node >/dev/null 2>&1; then
    node "$emitter" || {
      {
        printf '%s' '__CODETASK_ATTEST__'
        cat "$CODETASK_ATTESTATION_FILE"
        printf '\n'
      } >&2
    }
  else
    {
      printf '%s' '__CODETASK_ATTEST__'
      cat "$CODETASK_ATTESTATION_FILE"
      printf '\n'
    } >&2
  fi
fi
exec "$@"
"#;

pub fn write_attestation_artifact(
    runtime_root: &str,
    evidence: &SandboxEvidence,
) -> anyhow::Result<PathBuf> {
    let runtime = PathBuf::from(runtime_root);
    std::fs::create_dir_all(&runtime)?;
    let artifact_path = runtime.join(ATTESTATION_ARTIFACT_NAME);
    let mut payload = evidence.clone();
    payload.active = true;
    std::fs::write(&artifact_path, serde_json::to_string(&payload)?)?;
    let emitter_path = runtime.join(ATTESTATION_EMITTER_SCRIPT);
    std::fs::write(&emitter_path, EMITTER_SCRIPT_SOURCE)?;
    #[cfg(windows)]
    {
        let launcher_path = runtime.join(ATTESTATION_LAUNCHER_SCRIPT);
        std::fs::write(&launcher_path, LAUNCHER_SCRIPT_SOURCE)?;
    }
    Ok(artifact_path)
}

pub fn apply_attestation_env(
    env: &mut HashMap<String, String>,
    artifact_path: &Path,
    policy_sha256: &str,
    protocol_version: u32,
    read_roots_hash: &str,
    write_roots_hash: &str,
) {
    env.insert(
        "CODETASK_ATTESTATION_FILE".to_string(),
        artifact_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "CODETASK_POLICY_SHA256".to_string(),
        policy_sha256.to_string(),
    );
    env.insert(
        "CODETASK_POLICY_VERSION".to_string(),
        protocol_version.to_string(),
    );
    env.insert(
        "CODETASK_EFFECTIVE_READ_ROOTS_HASH".to_string(),
        read_roots_hash.to_string(),
    );
    env.insert(
        "CODETASK_EFFECTIVE_WRITE_ROOTS_HASH".to_string(),
        write_roots_hash.to_string(),
    );
    // Node inside macOS seatbelt cannot read the system OpenSSL config by default.
    env.insert("OPENSSL_CONF".to_string(), "/dev/null".to_string());
}

/// Wrap a command so attestation is emitted from inside the eventual sandbox process.
#[cfg(target_os = "macos")]
pub fn wrap_unix_command(command: &str, args: &[String]) -> (String, Vec<String>) {
    let script = format!("{UNIX_SHELL_PRELUDE}");
    let mut wrapped_args = vec![
        "-c".to_string(),
        script,
        "codetask-sandbox-attest".to_string(),
        command.to_string(),
    ];
    wrapped_args.extend(args.iter().cloned());
    ("/bin/sh".to_string(), wrapped_args)
}

/// Windows: emit attestation then run the worker via a Node launcher (no cmd.exe console).
#[cfg(windows)]
pub fn wrap_windows_command(
    node_exe: &str,
    emitter_script: &Path,
    command: &str,
    args: &[String],
) -> (String, Vec<String>) {
    let runtime_root = emitter_script
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let launcher = runtime_root.join(ATTESTATION_LAUNCHER_SCRIPT);
    let mut wrapped_args = vec![
        launcher.to_string_lossy().into_owned(),
        command.to_string(),
    ];
    wrapped_args.extend(args.iter().cloned());
    (node_exe.to_string(), wrapped_args)
}

pub fn strip_attestation_lines(buffer: &mut Vec<u8>, on_attestation: &mut dyn FnMut(SandboxEvidence)) {
    loop {
        let Some(newline) = buffer.iter().position(|&b| b == b'\n') else {
            break;
        };
        let line_bytes = buffer.drain(..=newline).collect::<Vec<_>>();
        let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
        if line.is_empty() {
            continue;
        }
        if let Some(json) = line.strip_prefix(ATTESTATION_MARKER) {
            if let Ok(evidence) = serde_json::from_str::<SandboxEvidence>(json) {
                on_attestation(evidence);
            }
            continue;
        }
        let mut restored = line.into_bytes();
        restored.push(b'\n');
        buffer.splice(0..0, restored);
        break;
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[cfg(windows)]
    #[test]
    fn wrap_windows_command_uses_node_launcher_not_cmd() {
        let (exe, args) = wrap_windows_command(
            r"E:\app\electron.exe",
            Path::new(r"E:\runtime\emit-sandbox-attestation.cjs"),
            r"E:\app\electron.exe",
            &[r"E:\out\role-worker.js".to_string()],
        );
        assert_eq!(exe, r"E:\app\electron.exe");
        assert_eq!(args[0], r"E:\runtime\launch-sandbox-worker.cjs");
        assert_eq!(args[1], r"E:\app\electron.exe");
        assert_eq!(args[2], r"E:\out\role-worker.js");
        assert!(!args.iter().any(|arg| arg.contains("cmd.exe")));
    }

    #[test]
    fn strips_attestation_line_from_buffer() {
        let mut buf = b"__CODETASK_ATTEST__{\"protocol_version\":2,\"active\":true,\"backend\":\"linux-bwrap-seccomp\",\"policy_sha256\":\"abc\",\"sandbox_pid\":1,\"warnings\":[]}\nuser stderr\n"
            .to_vec();
        let mut seen = false;
        strip_attestation_lines(&mut buf, &mut |evidence| {
            seen = evidence.active;
        });
        assert!(seen);
        assert_eq!(String::from_utf8(buf).unwrap(), "user stderr\n");
    }
}
