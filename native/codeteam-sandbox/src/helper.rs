//! Platform helper path resolution for NAPI.

#[cfg(target_os = "linux")]
pub fn resolve_helper_path() -> anyhow::Result<String> {
    Ok(crate::linux::resolve_linux_helper()?.display().to_string())
}

#[cfg(target_os = "macos")]
pub fn resolve_helper_path() -> anyhow::Result<String> {
    Ok("/usr/bin/sandbox-exec".to_string())
}

#[cfg(windows)]
pub fn resolve_helper_path() -> anyhow::Result<String> {
    use codeteam_windows_sandbox::resolve_host_launcher;

    let home = crate::windows::resolve_sandbox_home(None);
    let host = resolve_host_launcher(&home).ok_or_else(|| {
        anyhow::anyhow!("desktop host launcher not registered; run windowsSetup first")
    })?;
    Ok(host.runner_script.display().to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn resolve_helper_path() -> anyhow::Result<String> {
    anyhow::bail!("unsupported platform")
}

pub fn helper_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn run_self_test() -> anyhow::Result<()> {
    crate::spawn::preflight_all()?;
    #[cfg(windows)]
    {
        let home = crate::windows::resolve_sandbox_home(None);
        if !crate::windows::setup_is_complete(&home) {
            anyhow::bail!("windows sandbox setup incomplete; cannot self-test");
        }
    }
    Ok(())
}
