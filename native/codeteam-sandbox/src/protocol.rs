use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesystemPolicy {
    pub default_access: String,
    pub allowed_read_roots: Vec<String>,
    pub allowed_write_roots: Vec<String>,
    pub protected_names: Vec<String>,
    pub allow_system_runtime: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPolicy {
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
pub struct SandboxPolicy {
    pub version: u32,
    pub role: String,
    pub cwd: String,
    pub runtime_root: String,
    pub filesystem: FilesystemPolicy,
    pub network: NetworkPolicy,
    pub process: ProcessPolicy,
}

impl SandboxPolicy {
    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn runtime_root(&self) -> &str {
        &self.runtime_root
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
    if version != 2 {
        anyhow::bail!("unsupported policy version {version}");
    }
    Ok(serde_json::from_value(value)?)
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

#[cfg(test)]
mod tests {
    use super::parse_policy_json;
    use serde_json::json;

    fn policy_json(version: u32) -> String {
        json!({
            "version": version,
            "role": "planner",
            "cwd": "/tmp/workspace",
            "runtime_root": "/tmp/runtime",
            "filesystem": {
                "default_access": "none",
                "allowed_read_roots": ["/tmp/workspace", "/tmp/runtime"],
                "allowed_write_roots": ["/tmp/runtime"],
                "protected_names": [".git"],
                "allow_system_runtime": true
            },
            "network": {
                "mode": "full",
                "allow_loopback": true,
                "allow_unix_sockets": []
            },
            "process": {
                "isolate_from_host": true,
                "allow_own_descendant_signals": true,
                "deny_ptrace": true
            }
        })
        .to_string()
    }

    #[test]
    fn accepts_current_policy_protocol() {
        let policy = parse_policy_json(&policy_json(2)).expect("current policy should parse");
        assert_eq!(policy.version(), 2);
    }

    #[test]
    fn rejects_removed_v1_policy_protocol() {
        let error = parse_policy_json(&policy_json(1)).expect_err("V1 must be rejected");
        assert!(error.to_string().contains("unsupported policy version 1"));
    }
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
