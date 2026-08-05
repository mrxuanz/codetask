use std::collections::HashMap;
use std::path::PathBuf;

use crate::protocol::SandboxPolicy;

use super::elevated_child;

pub fn spawn(
    policy: &SandboxPolicy,
    policy_json: &str,
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
        command,
        args,
        env,
        allowed_read_roots,
        allowed_write_roots,
        allow_system_runtime,
    )
}
