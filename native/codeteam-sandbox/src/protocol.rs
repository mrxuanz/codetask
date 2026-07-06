use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct FileRule {
    pub path: String,
    pub access: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesystemPolicyV1 {
    pub default: String,
    pub rules: Vec<FileRule>,
    pub protected_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesystemPolicyV2 {
    pub default_access: String,
    pub allowed_read_roots: Vec<String>,
    pub allowed_write_roots: Vec<String>,
    pub protected_names: Vec<String>,
    pub allow_system_runtime: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPolicyV1 {
    pub ip: String,
    pub inbound: bool,
    pub allow_loopback: bool,
    #[serde(default)]
    pub unix_sockets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPolicyV2 {
    pub mode: String,
    pub allow_loopback: bool,
    #[serde(default)]
    pub allow_unix_sockets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessPolicy {
    pub isolate_from_host: bool,
    pub allow_own_descendant_signals: bool,
    pub deny_ptrace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxPolicyV1 {
    pub version: u32,
    pub role: String,
    pub cwd: String,
    pub runtime_root: String,
    pub filesystem: FilesystemPolicyV1,
    pub network: NetworkPolicyV1,
    pub process: ProcessPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxPolicyV2 {
    pub version: u32,
    pub role: String,
    pub cwd: String,
    pub runtime_root: String,
    pub filesystem: FilesystemPolicyV2,
    pub network: NetworkPolicyV2,
    pub process: ProcessPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SandboxPolicy {
    V1(SandboxPolicyV1),
    V2(SandboxPolicyV2),
}

impl SandboxPolicy {
    pub fn version(&self) -> u32 {
        match self {
            SandboxPolicy::V1(p) => p.version,
            SandboxPolicy::V2(p) => p.version,
        }
    }

    pub fn cwd(&self) -> &str {
        match self {
            SandboxPolicy::V1(p) => &p.cwd,
            SandboxPolicy::V2(p) => &p.cwd,
        }
    }

    pub fn runtime_root(&self) -> &str {
        match self {
            SandboxPolicy::V1(p) => &p.runtime_root,
            SandboxPolicy::V2(p) => &p.runtime_root,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxEvidence {
    pub protocol_version: u32,
    pub active: bool,
    pub backend: String,
    pub policy_sha256: String,
    pub sandbox_pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_read_roots_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_write_roots_hash: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

pub fn sha256_policy_json(json: &str) -> anyhow::Result<String> {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(json.as_bytes());
    Ok(format!("{:x}", digest))
}

pub fn parse_policy_json(json: &str) -> anyhow::Result<SandboxPolicy> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("policy missing version"))?;
    match version {
        1 => Ok(SandboxPolicy::V1(serde_json::from_value(value)?)),
        2 => Ok(SandboxPolicy::V2(serde_json::from_value(value)?)),
        other => anyhow::bail!("unsupported policy version {other}"),
    }
}

#[cfg(unix)]
#[allow(dead_code)]
pub fn read_policy_from_fd(fd: i32) -> anyhow::Result<SandboxPolicy> {
    use std::io::Read;
    use std::os::fd::FromRawFd;
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    parse_policy_json(&buf)
}

#[cfg(windows)]
#[allow(dead_code)]
pub fn read_policy_from_fd(fd: i32) -> anyhow::Result<SandboxPolicy> {
    use std::io::Read;
    use std::os::windows::io::FromRawHandle;
    let handle = fd as isize;
    let mut file = unsafe { std::fs::File::from_raw_handle(handle as *mut _) };
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    parse_policy_json(&buf)
}

#[cfg(unix)]
#[allow(dead_code)]
pub fn write_evidence_line(fd: i32, evidence: &SandboxEvidence) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::fd::FromRawFd;
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let line = serde_json::to_string(evidence)?;
    writeln!(file, "{line}")?;
    file.flush()?;
    Ok(())
}

#[cfg(windows)]
#[allow(dead_code)]
pub fn write_evidence_line(fd: i32, evidence: &SandboxEvidence) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    let handle = fd as isize;
    let mut file = unsafe { std::fs::File::from_raw_handle(handle as *mut _) };
    let line = serde_json::to_string(evidence)?;
    writeln!(file, "{line}")?;
    file.flush()?;
    Ok(())
}
