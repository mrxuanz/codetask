use std::collections::HashMap;
use std::path::PathBuf;

use codeteam_sandbox_adapter::ParsedTaskPolicy;

use crate::protocol::SandboxPolicy;

use super::elevated_child;

pub fn spawn(
    policy: &SandboxPolicy,
    policy_json: &str,
    parsed: &ParsedTaskPolicy,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    allowed_read_roots: &[PathBuf],
    allowed_write_roots: &[PathBuf],
    allow_system_runtime: bool,
) -> anyhow::Result<elevated_child::ElevatedChild> {
    elevated_child::ElevatedChild::spawn(
        policy,
        policy_json,
        parsed,
        command,
        args,
        env,
        allowed_read_roots,
        allowed_write_roots,
        allow_system_runtime,
    )
}
