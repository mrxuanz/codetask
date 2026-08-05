//! Maps Codetask V2 strict-whitelist `SandboxPolicy` JSON to runtime `PermissionProfile`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use codeteam_sandbox_policy::models::PermissionProfile;
use codeteam_sandbox_policy::{
    FileSystemAccessMode, FileSystemPath, FileSystemSandboxEntry, FileSystemSandboxPolicy,
    FileSystemSpecialPath, NetworkSandboxPolicy, SandboxPolicy,
};
use codeteam_utils_absolute_path::AbsolutePathBuf;
use serde::{Deserialize, Serialize};
use sha2::Digest;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFilesystemPolicyV2 {
    pub default_access: String,
    pub allowed_read_roots: Vec<String>,
    pub allowed_write_roots: Vec<String>,
    pub protected_names: Vec<String>,
    pub allow_system_runtime: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNetworkPolicyV2 {
    pub mode: String,
    pub allow_loopback: bool,
    #[serde(default)]
    pub allow_unix_sockets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProcessPolicy {
    pub isolate_from_host: bool,
    pub allow_own_descendant_signals: bool,
    pub deny_ptrace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSandboxPolicyV2 {
    pub version: u32,
    pub role: String,
    pub cwd: String,
    pub runtime_root: String,
    pub filesystem: TaskFilesystemPolicyV2,
    pub network: TaskNetworkPolicyV2,
    pub process: TaskProcessPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectiveRootsAttestation {
    pub effective_read_roots_hash: String,
    pub effective_write_roots_hash: String,
}

pub fn parse_task_policy_json(json: &str) -> Result<TaskSandboxPolicyV2> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .context("policy missing version")?;
    if version != 2 {
        anyhow::bail!("unsupported policy version {version} (only version 2 is supported)");
    }
    Ok(serde_json::from_value(value)?)
}

fn canonicalize_absolute_root(path: &str, label: &str) -> Result<AbsolutePathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        anyhow::bail!("{label} path is empty");
    }
    if trimmed.contains("..") {
        anyhow::bail!("{label} rejects relative path: {path}");
    }
    AbsolutePathBuf::from_absolute_path(trimmed)
        .with_context(|| format!("invalid {label} root {path}"))
}

fn reject_dangerous_write_root(path: &Path) -> Result<()> {
    let normalized = path.to_string_lossy();
    let lower = normalized.to_lowercase();
    if lower == "/" || lower == "c:\\" || lower == "c:" {
        anyhow::bail!("refusing dangerous write root: {normalized}");
    }
    Ok(())
}

fn dedup_roots(roots: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        let key = root.as_path().to_string_lossy().to_lowercase();
        if seen.insert(key) {
            out.push(root);
        }
    }
    out
}

fn hash_roots(roots: &[AbsolutePathBuf]) -> String {
    let mut sorted: Vec<String> = roots
        .iter()
        .map(|r| r.as_path().to_string_lossy().to_lowercase())
        .collect();
    sorted.sort();
    sorted.dedup();
    let digest = sha2::Sha256::digest(sorted.join("\n").as_bytes());
    format!("{:x}", digest)
}

fn network_policy_v2(policy: &TaskNetworkPolicyV2) -> NetworkSandboxPolicy {
    match policy.mode.as_str() {
        "full" => NetworkSandboxPolicy::Enabled,
        _ => NetworkSandboxPolicy::Restricted,
    }
}

/// Windows ACL path still consumes legacy `WorkspaceWrite` with explicit writable roots only.
pub fn to_legacy_sandbox_policy(policy: &TaskSandboxPolicyV2) -> Result<SandboxPolicy> {
    let cwd = Path::new(&policy.cwd);
    let mut writable_roots = Vec::new();
    for root in &policy.filesystem.allowed_write_roots {
        let path = canonicalize_absolute_root(root, "writable")?;
        reject_dangerous_write_root(path.as_path())?;
        if path.as_path() != cwd {
            writable_roots.push(path);
        }
    }
    Ok(SandboxPolicy::WorkspaceWrite {
        writable_roots,
        network_access: network_policy_v2(&policy.network).is_enabled(),
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
    })
}

fn append_protected_none_entries(
    entries: &mut Vec<FileSystemSandboxEntry>,
    writable_roots: &[AbsolutePathBuf],
    protected_names: &[String],
) {
    for root in writable_roots {
        for name in protected_names {
            let protected = root.join(name);
            entries.push(FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: protected },
                access: FileSystemAccessMode::None,
            });
        }
    }
}

fn build_filesystem_policy_v2(
    policy: &TaskSandboxPolicyV2,
    cwd: &Path,
) -> Result<(FileSystemSandboxPolicy, EffectiveRootsAttestation)> {
    if policy.filesystem.default_access != "none" {
        anyhow::bail!(
            "V2 sandbox requires default_access=none, got {}",
            policy.filesystem.default_access
        );
    }

    let mut entries: Vec<FileSystemSandboxEntry> = Vec::new();

    if policy.filesystem.allow_system_runtime {
        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::Minimal,
            },
            access: FileSystemAccessMode::Read,
        });
    }

    let mut read_roots = Vec::new();
    for root in &policy.filesystem.allowed_read_roots {
        let path = canonicalize_absolute_root(root, "read")?;
        read_roots.push(path.clone());
        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Path { path },
            access: FileSystemAccessMode::Read,
        });
    }

    let mut write_roots = Vec::new();
    for root in &policy.filesystem.allowed_write_roots {
        let path = canonicalize_absolute_root(root, "write")?;
        reject_dangerous_write_root(path.as_path())?;
        write_roots.push(path.clone());
        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Path { path },
            access: FileSystemAccessMode::Write,
        });
    }

    let runtime_tmp =
        canonicalize_absolute_root(&format!("{}/tmp", policy.runtime_root), "runtime tmp")?;
    if !write_roots
        .iter()
        .any(|root| root.as_path() == runtime_tmp.as_path())
    {
        write_roots.push(runtime_tmp.clone());
        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Path {
                path: runtime_tmp.clone(),
            },
            access: FileSystemAccessMode::Write,
        });
    }

    append_protected_none_entries(
        &mut entries,
        &write_roots,
        &policy.filesystem.protected_names,
    );

    let file_system = FileSystemSandboxPolicy::restricted(entries);
    let effective_read = dedup_roots(file_system.get_readable_roots_with_cwd(cwd));
    let effective_write: Vec<AbsolutePathBuf> = file_system
        .get_writable_roots_with_cwd(cwd)
        .into_iter()
        .map(|w| w.root)
        .collect();

    let attestation = EffectiveRootsAttestation {
        effective_read_roots_hash: hash_roots(&effective_read),
        effective_write_roots_hash: hash_roots(&effective_write),
    };

    Ok((file_system, attestation))
}

pub fn to_permission_profile(policy: &TaskSandboxPolicyV2) -> Result<PermissionProfile> {
    let cwd = Path::new(&policy.cwd);
    let (file_system, _attestation) = build_filesystem_policy_v2(policy, cwd)?;
    Ok(
        PermissionProfile::from_runtime_permissions_with_enforcement(
            codeteam_sandbox_policy::models::SandboxEnforcement::Managed,
            &file_system,
            network_policy_v2(&policy.network),
        ),
    )
}

pub fn effective_roots_attestation(
    policy: &TaskSandboxPolicyV2,
) -> Result<EffectiveRootsAttestation> {
    let (_, attestation) = build_filesystem_policy_v2(policy, Path::new(&policy.cwd))?;
    Ok(attestation)
}

pub fn legacy_policy_json(policy: &TaskSandboxPolicyV2) -> Result<String> {
    Ok(serde_json::to_string(&to_legacy_sandbox_policy(policy)?)?)
}

pub fn network_sandbox_policy(policy: &TaskSandboxPolicyV2) -> NetworkSandboxPolicy {
    network_policy_v2(&policy.network)
}

pub fn allowed_read_roots(policy: &TaskSandboxPolicyV2) -> Vec<PathBuf> {
    policy
        .filesystem
        .allowed_read_roots
        .iter()
        .filter_map(|root| canonicalize_absolute_root(root, "read").ok())
        .map(|p| p.into_path_buf())
        .collect()
}

pub fn allowed_write_roots(policy: &TaskSandboxPolicyV2) -> Vec<PathBuf> {
    policy
        .filesystem
        .allowed_write_roots
        .iter()
        .filter_map(|root| canonicalize_absolute_root(root, "write").ok())
        .map(|p| p.into_path_buf())
        .collect()
}

pub fn allow_system_runtime(policy: &TaskSandboxPolicyV2) -> bool {
    policy.filesystem.allow_system_runtime
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_v2_policy() -> TaskSandboxPolicyV2 {
        TaskSandboxPolicyV2 {
            version: 2,
            role: "task-worker".to_string(),
            cwd: "/workspace".to_string(),
            runtime_root: "/runtime".to_string(),
            filesystem: TaskFilesystemPolicyV2 {
                default_access: "none".to_string(),
                allowed_read_roots: vec!["/workspace".to_string(), "/runtime".to_string()],
                allowed_write_roots: vec!["/workspace".to_string(), "/runtime".to_string()],
                protected_names: vec![
                    ".git".to_string(),
                    ".agents".to_string(),
                    ".codex".to_string(),
                    ".codeteam".to_string(),
                ],
                allow_system_runtime: true,
            },
            network: TaskNetworkPolicyV2 {
                mode: "full".to_string(),
                allow_loopback: true,
                allow_unix_sockets: vec![],
            },
            process: TaskProcessPolicy {
                isolate_from_host: true,
                allow_own_descendant_signals: true,
                deny_ptrace: true,
            },
        }
    }

    #[test]
    fn v1_policies_are_rejected() {
        let json = r#"{"version": 1, "role": "task-worker"}"#;
        let error = parse_task_policy_json(json).unwrap_err();
        assert!(error.to_string().contains("unsupported policy version 1"));
    }

    #[test]
    fn missing_version_is_rejected() {
        let error = parse_task_policy_json("{}").unwrap_err();
        assert!(error.to_string().contains("policy missing version"));
    }

    #[test]
    fn v2_does_not_grant_full_disk_read() {
        let policy = sample_v2_policy();
        let profile = to_permission_profile(&policy).unwrap();
        let (fs, _) = profile.to_runtime_permissions();
        assert!(!fs.has_full_disk_read_access());
    }

    #[test]
    fn v2_includes_explicit_read_roots() {
        let policy = sample_v2_policy();
        let profile = to_permission_profile(&policy).unwrap();
        let (fs, _) = profile.to_runtime_permissions();
        let readable = fs.get_readable_roots_with_cwd(Path::new("/workspace"));
        assert!(
            readable
                .iter()
                .any(|p| p.as_path() == Path::new("/workspace"))
        );
        assert!(
            readable
                .iter()
                .any(|p| p.as_path() == Path::new("/runtime"))
        );
    }

    #[test]
    fn v2_rejects_dangerous_write_root() {
        let mut policy = sample_v2_policy();
        policy.filesystem.allowed_write_roots = vec!["/".to_string()];
        assert!(to_permission_profile(&policy).is_err());
    }

    #[test]
    fn v2_maps_to_workspace_write_legacy() {
        let policy = sample_v2_policy();
        let legacy = to_legacy_sandbox_policy(&policy).unwrap();
        assert!(matches!(
            legacy,
            SandboxPolicy::WorkspaceWrite {
                network_access: true,
                ..
            }
        ));
    }
}
