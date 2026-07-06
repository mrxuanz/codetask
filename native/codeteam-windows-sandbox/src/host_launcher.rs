//! Resolve the desktop host process (Electron/Node) used instead of standalone helper exes.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::winutil::quote_windows_arg;

const HOST_EXE_ENV: &str = "CODETASK_SANDBOX_HOST_EXE";
const SETUP_SCRIPT_ENV: &str = "CODETASK_SANDBOX_SETUP_SCRIPT";
const RUNNER_SCRIPT_ENV: &str = "CODETASK_SANDBOX_RUNNER_SCRIPT";
pub const ELECTRON_RUN_AS_NODE_ENV: &str = "ELECTRON_RUN_AS_NODE";
const ELECTRON_DISABLE_CRASH_REPORTER_ENV: &str = "ELECTRON_DISABLE_CRASH_REPORTER";
const ELECTRON_ENABLE_LOGGING_ENV: &str = "ELECTRON_ENABLE_LOGGING";
const CHROME_CRASHPAD_HANDLER_PID_ENV: &str = "CHROME_CRASHPAD_HANDLER_PID";
const CHROME_CRASHPAD_PIPE_NAME_ENV: &str = "CHROME_CRASHPAD_PIPE_NAME";
const BREAKPAD_DUMP_LOCATION_ENV: &str = "BREAKPAD_DUMP_LOCATION";

const HOST_PROFILE_ENV_KEYS: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
];

const INHERITED_CRASH_REPORTER_ENV_KEYS: &[&str] = &[
    CHROME_CRASHPAD_PIPE_NAME_ENV,
    CHROME_CRASHPAD_HANDLER_PID_ENV,
    "ELECTRON_CRASHPAD_PIPE_NAME",
    "CRASHPAD_HANDLER_PID",
];

pub fn electron_node_env_vars() -> [(&'static str, &'static str); 4] {
    [
        (ELECTRON_RUN_AS_NODE_ENV, "1"),
        (ELECTRON_DISABLE_CRASH_REPORTER_ENV, "1"),
        (ELECTRON_ENABLE_LOGGING_ENV, "0"),
        (CHROME_CRASHPAD_HANDLER_PID_ENV, "0"),
    ]
}

pub fn electron_node_env_remove_vars() -> &'static [&'static str] {
    INHERITED_CRASH_REPORTER_ENV_KEYS
}

fn remove_env_case_insensitive(env: &mut HashMap<String, String>, key: &str) {
    let existing_keys = env
        .keys()
        .filter(|existing| existing.eq_ignore_ascii_case(key))
        .cloned()
        .collect::<Vec<_>>();
    for existing in existing_keys {
        env.remove(&existing);
    }
}

fn set_env_case_insensitive(env: &mut HashMap<String, String>, key: &str, value: String) {
    remove_env_case_insensitive(env, key);
    env.insert(key.to_string(), value);
}

pub struct HostLauncher {
    pub host_exe: PathBuf,
    pub setup_script: PathBuf,
    pub runner_script: PathBuf,
}

/// Packaged Electron hosts must run with this env var to execute arbitrary `.js` entry scripts.
pub fn apply_electron_node_env(env: &mut HashMap<String, String>) {
    for key in electron_node_env_remove_vars() {
        remove_env_case_insensitive(env, key);
    }
    for (key, value) in electron_node_env_vars() {
        set_env_case_insensitive(env, key, value.to_string());
    }
}

pub fn with_electron_run_as_node(mut env: HashMap<String, String>) -> HashMap<String, String> {
    apply_electron_node_env(&mut env);
    env
}

pub fn parent_env_with_run_as_node() -> HashMap<String, String> {
    with_electron_run_as_node(std::env::vars().collect())
}

pub fn configure_electron_node_command(command: &mut Command) -> &mut Command {
    for key in electron_node_env_remove_vars() {
        command.env_remove(key);
    }
    command.envs(electron_node_env_vars())
}

pub fn sandbox_electron_profile_root(codex_home: &Path) -> PathBuf {
    codex_home.join(".sandbox").join("electron-profile")
}

pub fn ensure_sandbox_electron_profile_dirs(profile_root: &Path) -> io::Result<()> {
    for dir in [
        profile_root.to_path_buf(),
        profile_root.join("AppData").join("Roaming"),
        profile_root.join("AppData").join("Local"),
        profile_root
            .join("AppData")
            .join("Local")
            .join("CrashDumps"),
        profile_root.join("tmp"),
        profile_root.join("tmp").join("crashpad"),
        profile_root.join("config"),
        profile_root.join("cache"),
        profile_root.join("data"),
    ] {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

pub fn apply_isolated_profile_env(env: &mut HashMap<String, String>, profile_root: &Path) {
    for key in HOST_PROFILE_ENV_KEYS {
        remove_env_case_insensitive(env, key);
    }

    let root = profile_root.to_string_lossy().into_owned();
    let appdata = profile_root
        .join("AppData")
        .join("Roaming")
        .to_string_lossy()
        .into_owned();
    let localappdata = profile_root
        .join("AppData")
        .join("Local")
        .to_string_lossy()
        .into_owned();
    let tmp = profile_root.join("tmp").to_string_lossy().into_owned();
    let crashpad = profile_root
        .join("tmp")
        .join("crashpad")
        .to_string_lossy()
        .into_owned();

    set_env_case_insensitive(env, "HOME", root.clone());
    set_env_case_insensitive(env, "USERPROFILE", root.clone());
    set_env_case_insensitive(env, "APPDATA", appdata);
    set_env_case_insensitive(env, "LOCALAPPDATA", localappdata);
    set_env_case_insensitive(env, "TMPDIR", tmp.clone());
    set_env_case_insensitive(env, "TEMP", tmp.clone());
    set_env_case_insensitive(env, "TMP", tmp);
    set_env_case_insensitive(
        env,
        "XDG_CONFIG_HOME",
        profile_root.join("config").to_string_lossy().into_owned(),
    );
    set_env_case_insensitive(
        env,
        "XDG_CACHE_HOME",
        profile_root.join("cache").to_string_lossy().into_owned(),
    );
    set_env_case_insensitive(
        env,
        "XDG_DATA_HOME",
        profile_root.join("data").to_string_lossy().into_owned(),
    );
    set_env_case_insensitive(env, BREAKPAD_DUMP_LOCATION_ENV, crashpad);

    if root.as_bytes().get(1).copied() == Some(b':') {
        set_env_case_insensitive(env, "HOMEDRIVE", root[..2].to_string());
        set_env_case_insensitive(
            env,
            "HOMEPATH",
            if root.len() > 2 {
                root[2..].to_string()
            } else {
                "\\".to_string()
            },
        );
    }
}

pub fn sandbox_runner_env(
    codex_home: &Path,
    sandbox_username: &str,
) -> io::Result<HashMap<String, String>> {
    let profile_root = sandbox_electron_profile_root(codex_home);
    ensure_sandbox_electron_profile_dirs(&profile_root)?;
    let mut env = parent_env_with_run_as_node();
    apply_isolated_profile_env(&mut env, &profile_root);
    set_env_case_insensitive(&mut env, "USERNAME", sandbox_username.to_string());
    Ok(env)
}

/// Build `cmd.exe /c "set ...&& host script args..."` for elevated ShellExecute.
pub fn elevated_cmd_script_parameters(host_exe: &Path, script: &Path, args: &[&str]) -> String {
    let host = host_exe.to_string_lossy();
    let script = script.to_string_lossy();
    let mut inner = String::new();
    for key in electron_node_env_remove_vars() {
        inner.push_str(&format!("set \"{key}=\"&& "));
    }
    for (key, value) in electron_node_env_vars() {
        inner.push_str(&format!("set \"{key}={value}\"&& "));
    }
    inner.push_str(&format!(
        "{} {}",
        quote_windows_arg(host.as_ref()),
        quote_windows_arg(script.as_ref())
    ));
    for arg in args {
        inner.push(' ');
        inner.push_str(&quote_windows_arg(arg));
    }
    format!("/c {}", quote_windows_arg(&inner))
}

pub fn system_cmd_exe() -> PathBuf {
    std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"))
}

pub fn host_launcher_from_env() -> Option<HostLauncher> {
    let host_exe = std::env::var(HOST_EXE_ENV).ok().map(PathBuf::from)?;
    let setup_script = std::env::var(SETUP_SCRIPT_ENV).ok().map(PathBuf::from)?;
    let runner_script = std::env::var(RUNNER_SCRIPT_ENV).ok().map(PathBuf::from)?;
    if host_exe.is_file() && setup_script.is_file() && runner_script.is_file() {
        Some(HostLauncher {
            host_exe,
            setup_script,
            runner_script,
        })
    } else {
        None
    }
}

pub fn write_host_launcher_config(
    codex_home: &Path,
    host_exe: &Path,
    setup_script: &Path,
    runner_script: &Path,
) -> std::io::Result<()> {
    let dir = codex_home.join(".sandbox-bin");
    std::fs::create_dir_all(&dir)?;
    let config = serde_json::json!({
        "hostExe": host_exe,
        "setupScript": setup_script,
        "runnerScript": runner_script,
    });
    std::fs::write(
        dir.join("host-launcher.json"),
        serde_json::to_vec_pretty(&config)?,
    )
}

pub fn read_host_launcher_config(codex_home: &Path) -> Option<HostLauncher> {
    let path = codex_home.join(".sandbox-bin").join("host-launcher.json");
    let bytes = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let host_exe: PathBuf = value.get("hostExe")?.as_str()?.into();
    let setup_script: PathBuf = value.get("setupScript")?.as_str()?.into();
    let runner_script: PathBuf = value.get("runnerScript")?.as_str()?.into();
    if host_exe.is_file() && setup_script.is_file() && runner_script.is_file() {
        Some(HostLauncher {
            host_exe,
            setup_script,
            runner_script,
        })
    } else {
        None
    }
}

pub fn resolve_host_launcher(codex_home: &Path) -> Option<HostLauncher> {
    host_launcher_from_env().or_else(|| read_host_launcher_config(codex_home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevated_cmd_script_parameters_sets_electron_node_env() {
        let params = elevated_cmd_script_parameters(
            Path::new(r"C:\Program Files\App\electron.exe"),
            Path::new(r"C:\app\setup-entry.js"),
            &["payload"],
        );

        assert!(params.contains(r#"set \"ELECTRON_RUN_AS_NODE=1\""#));
        assert!(params.contains(r#"set \"ELECTRON_DISABLE_CRASH_REPORTER=1\""#));
        assert!(params.contains(r#"set \"ELECTRON_ENABLE_LOGGING=0\""#));
        assert!(params.contains(r#"set \"CHROME_CRASHPAD_HANDLER_PID=0\""#));
        assert!(params.contains(r#"set \"CHROME_CRASHPAD_PIPE_NAME=\""#));
        assert!(params.contains(r#"\"C:\Program Files\App\electron.exe\""#));
        assert!(params.contains(r#"C:\app\setup-entry.js"#));
        assert!(params.contains("payload"));
    }

    #[test]
    fn isolated_profile_env_replaces_host_profile_paths() {
        let profile = PathBuf::from(r"C:\sandbox-home\.sandbox\electron-profile");
        let env = HashMap::from([
            ("UserProfile".to_string(), r"C:\Users\admin".to_string()),
            (
                "LocalAppData".to_string(),
                r"C:\Users\admin\AppData\Local".to_string(),
            ),
            (
                "APPDATA".to_string(),
                r"C:\Users\admin\AppData\Roaming".to_string(),
            ),
            (
                "XDG_STATE_HOME".to_string(),
                r"C:\Users\admin\.state".to_string(),
            ),
            ("PATH".to_string(), r"C:\Windows\System32".to_string()),
            (
                "Chrome_Crashpad_Pipe_Name".to_string(),
                r"\\.\pipe\crashpad_host".to_string(),
            ),
        ]);

        let mut env = with_electron_run_as_node(env);
        apply_isolated_profile_env(&mut env, &profile);

        assert_eq!(
            env.get("USERPROFILE").map(String::as_str),
            Some(r"C:\sandbox-home\.sandbox\electron-profile")
        );
        assert_eq!(
            env.get("LOCALAPPDATA").map(String::as_str),
            Some(r"C:\sandbox-home\.sandbox\electron-profile\AppData\Local")
        );
        assert_eq!(
            env.get("APPDATA").map(String::as_str),
            Some(r"C:\sandbox-home\.sandbox\electron-profile\AppData\Roaming")
        );
        assert_eq!(
            env.get("BREAKPAD_DUMP_LOCATION").map(String::as_str),
            Some(r"C:\sandbox-home\.sandbox\electron-profile\tmp\crashpad")
        );
        assert_eq!(env.get("HOMEDRIVE").map(String::as_str), Some("C:"));
        assert_eq!(
            env.get("HOMEPATH").map(String::as_str),
            Some(r"\sandbox-home\.sandbox\electron-profile")
        );
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some(r"C:\Windows\System32")
        );
        assert!(!env.contains_key("UserProfile"));
        assert!(!env.contains_key("LocalAppData"));
        assert!(!env.contains_key("Chrome_Crashpad_Pipe_Name"));
        assert_eq!(
            env.get("CHROME_CRASHPAD_HANDLER_PID").map(String::as_str),
            Some("0")
        );
        assert!(!env.contains_key("XDG_STATE_HOME"));
    }

    #[test]
    fn sandbox_runner_env_creates_private_electron_profile_dirs() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let codex_home = temp.path().join("sandbox-home");
        let env = sandbox_runner_env(&codex_home, "codeteam-sandbox-test").expect("runner env");
        let profile = sandbox_electron_profile_root(&codex_home);

        assert!(profile.join("AppData").join("Roaming").is_dir());
        assert!(profile.join("AppData").join("Local").is_dir());
        assert!(profile.join("tmp").join("crashpad").is_dir());
        assert_eq!(
            env.get("USERNAME").map(String::as_str),
            Some("codeteam-sandbox-test")
        );
        assert_eq!(
            env.get("ELECTRON_RUN_AS_NODE").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("ELECTRON_DISABLE_CRASH_REPORTER")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("USERPROFILE"),
            Some(&profile.to_string_lossy().into_owned())
        );
    }
}
