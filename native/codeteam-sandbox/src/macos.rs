use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};

use codeteam_sandbox_adapter::{
    network_sandbox_policy, parse_task_policy_json, to_permission_profile, ParsedTaskPolicy,
};
use codeteam_sandboxing::seatbelt::{
    create_seatbelt_command_args, CreateSeatbeltCommandArgsParams,
    MACOS_PATH_TO_SEATBELT_EXECUTABLE,
};
use codeteam_utils_absolute_path::AbsolutePathBuf;

use crate::attestation::wrap_unix_command;

use crate::protocol::SandboxPolicy;

pub fn preflight() -> anyhow::Result<()> {
    if !Path::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE).is_file() {
        anyhow::bail!("macOS sandbox-exec missing at {MACOS_PATH_TO_SEATBELT_EXECUTABLE}");
    }
    Ok(())
}

pub fn spawn(
    policy: &SandboxPolicy,
    policy_json: &str,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> anyhow::Result<std::process::Child> {
    preflight()?;

    let task_policy = parse_task_policy_json(policy_json)?;
    let permission_profile = to_permission_profile(&task_policy)?;
    let (file_system_sandbox_policy, _) = permission_profile.to_runtime_permissions();
    let network_policy = network_sandbox_policy(&task_policy);
    let unix_socket_paths = match &task_policy {
        ParsedTaskPolicy::V1(v1) => &v1.network.unix_sockets,
        ParsedTaskPolicy::V2(v2) => &v2.network.allow_unix_sockets,
    };
    let unix_sockets: Vec<AbsolutePathBuf> = unix_socket_paths
        .iter()
        .map(|socket| AbsolutePathBuf::resolve_path_against_base(socket, policy.cwd()))
        .collect();

    let (wrapped_command, wrapped_args) = wrap_unix_command(command, args);
    let seatbelt_args = create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
        command: {
            let mut cmd = vec![wrapped_command];
            cmd.extend(wrapped_args);
            cmd
        },
        file_system_sandbox_policy: &file_system_sandbox_policy,
        network_sandbox_policy: network_policy,
        sandbox_policy_cwd: Path::new(policy.cwd()),
        enforce_managed_network: false,
        network: None,
        extra_allow_unix_sockets: &unix_sockets,
    });

    let mut cmd = Command::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE);
    cmd.args(seatbelt_args)
        .current_dir(policy.cwd())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.env("CODETASK_OUTER_SANDBOX", "1");
    Ok(cmd.spawn()?)
}
