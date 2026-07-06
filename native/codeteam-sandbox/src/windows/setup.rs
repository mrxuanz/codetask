use std::collections::HashMap;
use std::path::{Path, PathBuf};

use codeteam_sandbox_policy::protocol::SandboxPolicy as LegacySandboxPolicy;
use codeteam_windows_sandbox::{
    SandboxSetupRequest, SetupRootOverrides, execute_setup_payload_b64, run_elevated_setup,
    sandbox_setup_is_complete, write_host_launcher_config,
};

pub fn resolve_sandbox_home(explicit: Option<&str>) -> PathBuf {
    if let Some(value) = explicit {
        return PathBuf::from(value);
    }
    if let Ok(home) = std::env::var("CODETASK_SANDBOX_HOME") {
        return PathBuf::from(home);
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("codetask").join("sandbox-home");
    }
    PathBuf::from(".codetask-sandbox-home")
}

pub fn setup_is_complete(home: &Path) -> bool {
    sandbox_setup_is_complete(home)
}

pub fn register_host_launcher(
    host_exe: &str,
    setup_script: &str,
    runner_script: &str,
    sandbox_home: &str,
) -> anyhow::Result<()> {
    let home = PathBuf::from(sandbox_home);
    std::fs::create_dir_all(home.join("sandbox"))?;
    write_host_launcher_config(
        &home,
        Path::new(host_exe),
        Path::new(setup_script),
        Path::new(runner_script),
    )?;
    // SAFETY: single-threaded NAPI init before spawning sandbox children.
    unsafe {
        std::env::set_var("CODETASK_SANDBOX_HOST_EXE", host_exe);
        std::env::set_var("CODETASK_SANDBOX_SETUP_SCRIPT", setup_script);
        std::env::set_var("CODETASK_SANDBOX_RUNNER_SCRIPT", runner_script);
    }
    Ok(())
}

pub fn setup(
    node_exe: &str,
    setup_script: &str,
    runner_script: &str,
    sandbox_home: &str,
    policy_cwd: &str,
) -> anyhow::Result<()> {
    let home = PathBuf::from(sandbox_home);
    std::fs::create_dir_all(home.join("sandbox"))?;

    register_host_launcher(node_exe, setup_script, runner_script, sandbox_home)?;

    if setup_is_complete(&home) {
        return Ok(());
    }

    let policy = LegacySandboxPolicy::WorkspaceWrite {
        writable_roots: vec![],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
    };

    let request = SandboxSetupRequest {
        policy: &policy,
        policy_cwd: Path::new(policy_cwd),
        command_cwd: Path::new(policy_cwd),
        codex_home: &home,
        env_map: &HashMap::new(),
        proxy_enforced: false,
    };

    run_elevated_setup(
        request,
        SetupRootOverrides {
            read_roots: None,
            read_roots_include_platform_defaults: true,
            write_roots: None,
            deny_read_paths: None,
            deny_write_paths: None,
        },
    )?;

    if !setup_is_complete(&home) {
        anyhow::bail!("setup finished but marker files missing");
    }
    Ok(())
}

/// Invoked under elevation from `setup-entry.js` inside the desktop host process.
pub fn run_setup_helper(payload_b64: &str) -> anyhow::Result<()> {
    execute_setup_payload_b64(payload_b64)
}

pub fn run_command_runner(args: Vec<String>) -> anyhow::Result<()> {
    codeteam_windows_sandbox::run_command_runner(args)
}
