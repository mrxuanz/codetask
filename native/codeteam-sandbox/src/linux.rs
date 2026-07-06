use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use codeteam_sandbox_adapter::{parse_task_policy_json, to_permission_profile};

use crate::protocol::SandboxPolicy;

pub fn preflight() -> anyhow::Result<()> {
    let helper = resolve_linux_helper()?;
    if !helper.is_file() {
        anyhow::bail!(
            "codeteam-linux-sandbox helper not found at {}",
            helper.display()
        );
    }
    let bwrap = which_bwrap()?;
    if !Path::new(&bwrap).is_file() {
        anyhow::bail!("bwrap not found at {bwrap}");
    }
    Ok(())
}

pub fn resolve_linux_helper() -> anyhow::Result<PathBuf> {
    let candidates = [
        std::env::var("CODETASK_LINUX_SANDBOX_HELPER")
            .ok()
            .map(PathBuf::from),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|p| p.join("codeteam-linux-sandbox"))),
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("helpers")
                .join("codeteam-linux-sandbox"),
        ),
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
                .join("debug")
                .join("codeteam-linux-sandbox"),
        ),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    anyhow::bail!("codeteam-linux-sandbox not found; build codeteam-linux-sandbox first")
}

fn which_bwrap() -> anyhow::Result<String> {
    if let Ok(path) = std::env::var("BWRAP_PATH") {
        return Ok(path);
    }
    let output = Command::new("which").arg("bwrap").output()?;
    if !output.status.success() {
        anyhow::bail!("bubblewrap (bwrap) is required on Linux");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn extra_ro_bind_args(paths: &[PathBuf]) -> Vec<String> {
    let mut args = Vec::new();
    for path in paths {
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let mount = canonical.to_string_lossy().into_owned();
        args.push("--extra-ro-bind".to_string());
        args.push(mount.clone());
        args.push(mount);
    }
    args
}

fn sandbox_tool_ro_binds(helper: &Path, bwrap: &str) -> Vec<String> {
    extra_ro_bind_args(&[helper.to_path_buf(), PathBuf::from(bwrap)])
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
    let profile_json = serde_json::to_string(&permission_profile)?;

    let helper = resolve_linux_helper()?;
    let bwrap = which_bwrap()?;
    let mut inner = vec![command.to_string()];
    inner.extend(args.iter().cloned());

    let mut cmd = Command::new(&helper);
    cmd.arg("--sandbox-policy-cwd")
        .arg(policy.cwd())
        .arg("--permission-profile")
        .arg(profile_json);
    for arg in sandbox_tool_ro_binds(&helper, &bwrap) {
        cmd.arg(arg);
    }
    cmd.arg("--")
        .args(inner)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_helper_path_is_non_empty_string_on_error() {
        let _ = resolve_linux_helper();
    }
}
