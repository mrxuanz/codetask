use std::collections::HashMap;

use codeteam_sandbox_adapter::{effective_roots_attestation, parse_task_policy_json};

use crate::attestation::{apply_attestation_env, write_attestation_artifact};
use crate::protocol::{SandboxEvidence, SandboxPolicy, sha256_policy_json};

#[cfg(windows)]
pub struct SpawnedSandbox {
    pub child: crate::windows::elevated_child::ElevatedChild,
    pub evidence: SandboxEvidence,
}

#[cfg(not(windows))]
pub struct SpawnedSandbox {
    pub child: std::process::Child,
    pub evidence: SandboxEvidence,
}

pub fn spawn_sandboxed(
    policy: SandboxPolicy,
    policy_json: &str,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> anyhow::Result<SpawnedSandbox> {
    if command.is_empty() {
        anyhow::bail!("command is required");
    }

    ensure_runtime_dirs(&policy)?;

    let parsed = parse_task_policy_json(policy_json)?;
    let attestation = effective_roots_attestation(&parsed)?;
    let protocol_version = policy.version();

    let hash = sha256_policy_json(policy_json)?;
    let backend = default_backend();
    let mut evidence = SandboxEvidence {
        protocol_version,
        active: false,
        backend,
        policy_sha256: hash.clone(),
        sandbox_pid: 0,
        effective_read_roots_hash: Some(attestation.effective_read_roots_hash.clone()),
        effective_write_roots_hash: Some(attestation.effective_write_roots_hash.clone()),
        warnings: vec![],
    };

    let artifact_path = write_attestation_artifact(policy.runtime_root(), &evidence)?;
    let mut child_env = env.clone();
    apply_attestation_env(
        &mut child_env,
        &artifact_path,
        &hash,
        protocol_version,
        &attestation.effective_read_roots_hash,
        &attestation.effective_write_roots_hash,
    );

    #[cfg(windows)]
    let (read_roots, write_roots, include_platform_defaults) = (
        codeteam_sandbox_adapter::allowed_read_roots(&parsed),
        codeteam_sandbox_adapter::allowed_write_roots(&parsed),
        codeteam_sandbox_adapter::allow_system_runtime(&parsed),
    );

    #[cfg(windows)]
    {
        let child = crate::windows::spawn(
            &policy,
            policy_json,
            &parsed,
            command,
            args,
            &child_env,
            &read_roots,
            &write_roots,
            include_platform_defaults,
        )?;
        evidence.sandbox_pid = child.id();
        return Ok(SpawnedSandbox { child, evidence });
    }

    #[cfg(target_os = "linux")]
    {
        let child = crate::linux::spawn(&policy, policy_json, command, args, &child_env)?;
        evidence.sandbox_pid = child.id();
        return Ok(SpawnedSandbox { child, evidence });
    }

    #[cfg(target_os = "macos")]
    {
        let child = crate::macos::spawn(&policy, policy_json, command, args, &child_env)?;
        evidence.sandbox_pid = child.id();
        return Ok(SpawnedSandbox { child, evidence });
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        anyhow::bail!("unsupported platform");
    }
}

fn ensure_runtime_dirs(policy: &SandboxPolicy) -> anyhow::Result<()> {
    let runtime_root = policy.runtime_root();
    std::fs::create_dir_all(format!("{runtime_root}/tmp"))?;

    match policy {
        SandboxPolicy::V1(p) => {
            for rule in &p.filesystem.rules {
                if rule.access == "write" {
                    std::fs::create_dir_all(&rule.path)?;
                }
            }
        }
        SandboxPolicy::V2(p) => {
            for root in &p.filesystem.allowed_write_roots {
                std::fs::create_dir_all(root)?;
            }
        }
    }
    Ok(())
}

fn default_backend() -> String {
    #[cfg(target_os = "linux")]
    return "linux-bwrap-seccomp".to_string();
    #[cfg(target_os = "macos")]
    return "macos-seatbelt".to_string();
    #[cfg(windows)]
    return "windows-elevated".to_string();
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    return "unknown".to_string();
}

pub fn preflight_all() -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    crate::linux::preflight()?;
    #[cfg(target_os = "macos")]
    crate::macos::preflight()?;
    #[cfg(windows)]
    crate::windows::preflight()?;
    Ok(())
}
