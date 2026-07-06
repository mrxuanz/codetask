//! Maps Codetask `SandboxPolicy` JSON (V1 legacy + V2 strict whitelist) to runtime `PermissionProfile`.

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

// --- V1 legacy types (full-disk-read projection; not a strict whitelist) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileRule {
    pub path: String,
    pub access: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFilesystemPolicyV1 {
    pub default: String,
    pub rules: Vec<TaskFileRule>,
    pub protected_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNetworkPolicyV1 {
    pub ip: String,
    pub inbound: bool,
    pub allow_loopback: bool,
    #[serde(default)]
    pub unix_sockets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProcessPolicy {
    pub isolate_from_host: bool,
    pub allow_own_descendant_signals: bool,
    pub deny_ptrace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSandboxPolicyV1 {
    pub version: u32,
    pub role: String,
    pub cwd: String,
    pub runtime_root: String,
    pub filesystem: TaskFilesystemPolicyV1,
    pub network: TaskNetworkPolicyV1,
    pub process: TaskProcessPolicy,
}

// --- V2 strict whitelist ---

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
pub struct TaskSandboxPolicyV2 {
    pub version: u32,
    pub role: String,
    pub cwd: String,
    pub runtime_root: String,
    pub filesystem: TaskFilesystemPolicyV2,
    pub network: TaskNetworkPolicyV2,
    pub process: TaskProcessPolicy,
}

#[derive(Debug, Clone)]
pub enum ParsedTaskPolicy {
    V1(TaskSandboxPolicyV1),
    V2(TaskSandboxPolicyV2),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectiveRootsAttestation {
    pub effective_read_roots_hash: String,
    pub effective_write_roots_hash: String,
}

pub fn parse_task_policy_json(json: &str) -> Result<ParsedTaskPolicy> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .context("policy missing version")?;
    match version {
        1 => Ok(ParsedTaskPolicy::V1(serde_json::from_value(value)?)),
        2 => Ok(ParsedTaskPolicy::V2(serde_json::from_value(value)?)),
        other => anyhow::bail!("unsupported policy version {other}"),
    }
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

fn network_policy_v1(policy: &TaskNetworkPolicyV1) -> NetworkSandboxPolicy {
    if policy.ip == "full" {
        NetworkSandboxPolicy::Enabled
    } else {
        NetworkSandboxPolicy::Restricted
    }
}

fn network_policy_v2(policy: &TaskNetworkPolicyV2) -> NetworkSandboxPolicy {
    match policy.mode.as_str() {
        "full" => NetworkSandboxPolicy::Enabled,
        "none" | "restricted" => NetworkSandboxPolicy::Restricted,
        other => {
            let _ = other;
            NetworkSandboxPolicy::Restricted
        }
    }
}

/// V1 legacy: projects to ReadOnly / WorkspaceWrite (full-disk read). Not a strict whitelist.
pub fn to_legacy_sandbox_policy_v1(policy: &TaskSandboxPolicyV1) -> Result<SandboxPolicy> {
    let cwd = Path::new(&policy.cwd);
    let mut writable_roots: Vec<AbsolutePathBuf> = Vec::new();

    for rule in &policy.filesystem.rules {
        if rule.access == "write" {
            let path = canonicalize_absolute_root(&rule.path, "writable")?;
            if path.as_path() != cwd {
                writable_roots.push(path);
            }
        }
    }

    let network_access = policy.network.ip == "full";
    let has_workspace_write = policy
        .filesystem
        .rules
        .iter()
        .any(|r| r.access == "write" && Path::new(&r.path) == cwd);

    if has_workspace_write || !writable_roots.is_empty() {
        Ok(SandboxPolicy::WorkspaceWrite {
            writable_roots,
            network_access,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        })
    } else {
        Ok(SandboxPolicy::ReadOnly { network_access })
    }
}

pub fn to_legacy_sandbox_policy(policy: &ParsedTaskPolicy) -> Result<SandboxPolicy> {
    match policy {
        ParsedTaskPolicy::V1(v1) => to_legacy_sandbox_policy_v1(v1),
        ParsedTaskPolicy::V2(v2) => to_legacy_sandbox_policy_v2(v2),
    }
}

/// Windows ACL path still consumes legacy `WorkspaceWrite` with explicit writable roots only.
fn to_legacy_sandbox_policy_v2(policy: &TaskSandboxPolicyV2) -> Result<SandboxPolicy> {
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

pub fn to_permission_profile(policy: &ParsedTaskPolicy) -> Result<PermissionProfile> {
    match policy {
        ParsedTaskPolicy::V1(v1) => {
            let legacy = to_legacy_sandbox_policy_v1(v1)?;
            let cwd = Path::new(&v1.cwd);
            Ok(PermissionProfile::from_legacy_sandbox_policy_for_cwd(
                &legacy, cwd,
            ))
        }
        ParsedTaskPolicy::V2(v2) => to_permission_profile_v2(v2),
    }
}

pub fn to_permission_profile_v2(policy: &TaskSandboxPolicyV2) -> Result<PermissionProfile> {
    let cwd = Path::new(&policy.cwd);
    let (file_system, _attestation) = build_filesystem_policy_v2(policy, cwd)?;
    Ok(PermissionProfile::from_runtime_permissions_with_enforcement(
        codeteam_sandbox_policy::models::SandboxEnforcement::Managed,
        &file_system,
        network_policy_v2(&policy.network),
    ))
}

pub fn effective_roots_attestation(policy: &ParsedTaskPolicy) -> Result<EffectiveRootsAttestation> {
    match policy {
        ParsedTaskPolicy::V1(v1) => {
            let profile = to_permission_profile(policy)?;
            let cwd = Path::new(&v1.cwd);
            let (fs, _) = profile.to_runtime_permissions();
            Ok(EffectiveRootsAttestation {
                effective_read_roots_hash: hash_roots(&fs.get_readable_roots_with_cwd(cwd)),
                effective_write_roots_hash: hash_roots(
                    &fs.get_writable_roots_with_cwd(cwd)
                        .into_iter()
                        .map(|w| w.root)
                        .collect::<Vec<_>>(),
                ),
            })
        }
        ParsedTaskPolicy::V2(v2) => {
            let (_, attestation) = build_filesystem_policy_v2(v2, Path::new(&v2.cwd))?;
            Ok(attestation)
        }
    }
}

pub fn legacy_policy_json(policy: &ParsedTaskPolicy) -> Result<String> {
    Ok(serde_json::to_string(&to_legacy_sandbox_policy(policy)?)?)
}

pub fn network_enabled(policy: &ParsedTaskPolicy) -> bool {
    match policy {
        ParsedTaskPolicy::V1(v1) => v1.network.ip == "full",
        ParsedTaskPolicy::V2(v2) => network_policy_v2(&v2.network).is_enabled(),
    }
}

pub fn network_sandbox_policy(policy: &ParsedTaskPolicy) -> NetworkSandboxPolicy {
    match policy {
        ParsedTaskPolicy::V1(v1) => network_policy_v1(&v1.network),
        ParsedTaskPolicy::V2(v2) => network_policy_v2(&v2.network),
    }
}

pub fn policy_cwd(policy: &ParsedTaskPolicy) -> &str {
    match policy {
        ParsedTaskPolicy::V1(v1) => &v1.cwd,
        ParsedTaskPolicy::V2(v2) => &v2.cwd,
    }
}

pub fn policy_runtime_root(policy: &ParsedTaskPolicy) -> &str {
    match policy {
        ParsedTaskPolicy::V1(v1) => &v1.runtime_root,
        ParsedTaskPolicy::V2(v2) => &v2.runtime_root,
    }
}

pub fn allowed_read_roots(policy: &ParsedTaskPolicy) -> Vec<PathBuf> {
    match policy {
        ParsedTaskPolicy::V1(_) => Vec::new(),
        ParsedTaskPolicy::V2(v2) => v2
            .filesystem
            .allowed_read_roots
            .iter()
            .filter_map(|root| canonicalize_absolute_root(root, "read").ok())
            .map(|p| p.into_path_buf())
            .collect(),
    }
}

pub fn allowed_write_roots(policy: &ParsedTaskPolicy) -> Vec<PathBuf> {
    match policy {
        ParsedTaskPolicy::V1(v1) => v1
            .filesystem
            .rules
            .iter()
            .filter(|r| r.access == "write")
            .filter_map(|r| canonicalize_absolute_root(&r.path, "write").ok())
            .map(|p| p.into_path_buf())
            .collect(),
        ParsedTaskPolicy::V2(v2) => v2
            .filesystem
            .allowed_write_roots
            .iter()
            .filter_map(|root| canonicalize_absolute_root(root, "write").ok())
            .map(|p| p.into_path_buf())
            .collect(),
    }
}

pub fn allow_system_runtime(policy: &ParsedTaskPolicy) -> bool {
    match policy {
        ParsedTaskPolicy::V1(_) => true,
        ParsedTaskPolicy::V2(v2) => v2.filesystem.allow_system_runtime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_v1_task_policy(role_write: bool) -> TaskSandboxPolicyV1 {
        let mut rules = vec![TaskFileRule {
            path: "/runtime".to_string(),
            access: "write".to_string(),
        }];
        if role_write {
            rules.push(TaskFileRule {
                path: "/workspace".to_string(),
                access: "write".to_string(),
            });
        }
        TaskSandboxPolicyV1 {
            version: 1,
            role: if role_write {
                "task-worker".to_string()
            } else {
                "planner".to_string()
            },
            cwd: "/workspace".to_string(),
            runtime_root: "/runtime".to_string(),
            filesystem: TaskFilesystemPolicyV1 {
                default: "read".to_string(),
                rules,
                protected_names: vec![".codeteam".to_string()],
            },
            network: TaskNetworkPolicyV1 {
                ip: "full".to_string(),
                inbound: false,
                allow_loopback: true,
                unix_sockets: vec![],
            },
            process: TaskProcessPolicy {
                isolate_from_host: true,
                allow_own_descendant_signals: true,
                deny_ptrace: true,
            },
        }
    }

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
    fn v1_maps_to_workspace_write_legacy() {
        let policy = ParsedTaskPolicy::V1(sample_v1_task_policy(true));
        let legacy = to_legacy_sandbox_policy(&policy).unwrap();
        assert!(matches!(
            legacy,
            SandboxPolicy::WorkspaceWrite {
                network_access: true,
                ..
            }
        ));
    }

    #[test]
    fn v2_does_not_grant_full_disk_read() {
        let policy = ParsedTaskPolicy::V2(sample_v2_policy());
        let profile = to_permission_profile(&policy).unwrap();
        let (fs, _) = profile.to_runtime_permissions();
        assert!(!fs.has_full_disk_read_access());
    }

    #[test]
    fn v2_includes_explicit_read_roots() {
        let policy = ParsedTaskPolicy::V2(sample_v2_policy());
        let profile = to_permission_profile(&policy).unwrap();
        let (fs, _) = profile.to_runtime_permissions();
        let readable = fs.get_readable_roots_with_cwd(Path::new("/workspace"));
        assert!(readable.iter().any(|p| p.as_path() == Path::new("/workspace")));
        assert!(readable.iter().any(|p| p.as_path() == Path::new("/runtime")));
    }

    #[test]
    fn v2_rejects_dangerous_write_root() {
        let mut v2 = sample_v2_policy();
        v2.filesystem.allowed_write_roots = vec!["/".to_string()];
        let policy = ParsedTaskPolicy::V2(v2);
        assert!(to_permission_profile(&policy).is_err());
    }
}
