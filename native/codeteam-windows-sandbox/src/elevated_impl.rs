use codeteam_utils_absolute_path::AbsolutePathBuf;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

pub struct ElevatedSandboxCaptureRequest<'a> {
    pub policy_json_or_preset: &'a str,
    pub sandbox_policy_cwd: &'a Path,
    pub codex_home: &'a Path,
    pub command: Vec<String>,
    pub cwd: &'a Path,
    pub env_map: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
    pub use_private_desktop: bool,
    pub proxy_enforced: bool,
    pub read_roots_override: Option<&'a [PathBuf]>,
    pub read_roots_include_platform_defaults: bool,
    pub extra_read_roots: &'a [PathBuf],
    pub write_roots_override: Option<&'a [PathBuf]>,
    pub deny_read_paths_override: &'a [AbsolutePathBuf],
    pub deny_write_paths_override: &'a [AbsolutePathBuf],
}

mod windows_impl {
    use super::ElevatedSandboxCaptureRequest;
    use crate::acl::allow_null_device;
    use crate::cap::load_or_create_cap_sids;
    use crate::cap::workspace_write_cap_sid_for_root;
    use crate::env::ensure_non_interactive_pager;
    use crate::env::inherit_path_env;
    use crate::env::normalize_null_device_env;
    use crate::identity::require_logon_sandbox_creds;
    use crate::ipc_framed::EmptyPayload;
    use crate::ipc_framed::FramedMessage;
    use crate::ipc_framed::Message;
    use crate::ipc_framed::OutputStream;
    use crate::ipc_framed::SpawnRequest;
    use crate::ipc_framed::decode_bytes;
    use crate::ipc_framed::read_frame;
    use crate::ipc_framed::write_frame;
    use crate::logging::log_failure;
    use crate::logging::log_start;
    use crate::logging::log_success;
    use crate::policy::SandboxPolicy;
    use crate::policy::parse_policy;
    use crate::runner_client::spawn_runner_transport;
    use crate::sandbox_utils::ensure_codex_home_exists;
    use crate::sandbox_utils::inject_git_safe_directory;
    use crate::setup::effective_write_roots_for_setup;
    use crate::token::LocalSid;
    use anyhow::Result;
    use codeteam_utils_absolute_path::AbsolutePathBuf;
    use std::fs::File;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    pub use crate::windows_impl::CaptureResult;

    /// Shared cancel handle + runner pipe for streaming capture and real terminate.
    #[derive(Clone)]
    pub struct StreamingCaptureControl {
        pub cancelled: Arc<AtomicBool>,
        pipe_write: Arc<Mutex<Option<File>>>,
        runner_pid: Arc<Mutex<Option<u32>>>,
    }

    impl StreamingCaptureControl {
        pub fn new() -> Self {
            Self {
                cancelled: Arc::new(AtomicBool::new(false)),
                pipe_write: Arc::new(Mutex::new(None)),
                runner_pid: Arc::new(Mutex::new(None)),
            }
        }

        pub fn pipe_write_holder(&self) -> Arc<Mutex<Option<File>>> {
            self.pipe_write.clone()
        }

        pub fn runner_pid_holder(&self) -> Arc<Mutex<Option<u32>>> {
            self.runner_pid.clone()
        }

        pub fn request_cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
            send_runner_terminate(&self.pipe_write);
            if let Some(pid) = *self.runner_pid.lock().unwrap() {
                force_terminate_pid(pid);
            }
        }
    }

    impl Default for StreamingCaptureControl {
        fn default() -> Self {
            Self::new()
        }
    }

    fn send_runner_terminate(pipe_write: &Arc<Mutex<Option<File>>>) {
        let mut guard = match pipe_write.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(mut file) = guard.take() {
            let msg = FramedMessage {
                version: 1,
                message: Message::Terminate {
                    payload: EmptyPayload::default(),
                },
            };
            let _ = write_frame(&mut file, &msg);
        }
    }

    fn force_terminate_pid(pid: u32) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle != 0 {
                let _ = TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }

    fn extend_output(
        stream: OutputStream,
        bytes: &[u8],
        live_stdout: Option<&Arc<Mutex<Vec<u8>>>>,
        live_stderr: Option<&Arc<Mutex<Vec<u8>>>>,
        stdout: &mut Vec<u8>,
        stderr: &mut Vec<u8>,
    ) {
        match stream {
            OutputStream::Stdout => {
                if let Some(buf) = live_stdout {
                    buf.lock().unwrap().extend_from_slice(bytes);
                } else {
                    stdout.extend_from_slice(bytes);
                }
            }
            OutputStream::Stderr => {
                if let Some(buf) = live_stderr {
                    buf.lock().unwrap().extend_from_slice(bytes);
                } else {
                    stderr.extend_from_slice(bytes);
                }
            }
        }
    }

    fn run_capture_io_loop(
        mut pipe_read: File,
        pipe_write: Arc<Mutex<Option<File>>>,
        cancelled: Arc<AtomicBool>,
        runner_pid: Arc<Mutex<Option<u32>>>,
        live_stdout: Option<Arc<Mutex<Vec<u8>>>>,
        live_stderr: Option<Arc<Mutex<Vec<u8>>>>,
    ) -> Result<(i32, bool, Vec<u8>, Vec<u8>)> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let (exit_code, timed_out) = loop {
            if cancelled.load(Ordering::SeqCst) {
                send_runner_terminate(&pipe_write);
                if let Some(pid) = *runner_pid.lock().unwrap() {
                    force_terminate_pid(pid);
                }
                break (-1, false);
            }

            let msg = read_frame(&mut pipe_read)?
                .ok_or_else(|| anyhow::anyhow!("runner pipe closed before exit"))?;
            match msg.message {
                Message::SpawnReady { payload } => {
                    *runner_pid.lock().unwrap() = Some(payload.process_id);
                }
                Message::Output { payload } => {
                    let bytes = decode_bytes(&payload.data_b64)?;
                    extend_output(
                        payload.stream,
                        &bytes,
                        live_stdout.as_ref(),
                        live_stderr.as_ref(),
                        &mut stdout,
                        &mut stderr,
                    );
                }
                Message::Exit { payload } => break (payload.exit_code, payload.timed_out),
                Message::Error { payload } => {
                    return Err(anyhow::anyhow!("runner error: {}", payload.message));
                }
                other => {
                    return Err(anyhow::anyhow!(
                        "unexpected runner message during capture: {other:?}"
                    ));
                }
            }
        };
        Ok((exit_code, timed_out, stdout, stderr))
    }

    /// Launches the command runner under the sandbox user and captures its output.
    #[allow(clippy::too_many_arguments)]
    pub fn run_windows_sandbox_capture(
        request: ElevatedSandboxCaptureRequest<'_>,
    ) -> Result<CaptureResult> {
        let ElevatedSandboxCaptureRequest {
            policy_json_or_preset,
            sandbox_policy_cwd,
            codex_home,
            command,
            cwd,
            mut env_map,
            timeout_ms,
            use_private_desktop,
            proxy_enforced,
            read_roots_override,
            read_roots_include_platform_defaults,
            extra_read_roots,
            write_roots_override,
            deny_read_paths_override,
            deny_write_paths_override,
        } = request;
        let deny_read_paths_override = deny_read_paths_override
            .iter()
            .map(AbsolutePathBuf::to_path_buf)
            .collect::<Vec<_>>();
        let deny_write_paths_override = deny_write_paths_override
            .iter()
            .map(AbsolutePathBuf::to_path_buf)
            .collect::<Vec<_>>();
        let policy = parse_policy(policy_json_or_preset)?;
        normalize_null_device_env(&mut env_map);
        ensure_non_interactive_pager(&mut env_map);
        inherit_path_env(&mut env_map);
        inject_git_safe_directory(&mut env_map, cwd);
        // Use a temp-based log dir that the sandbox user can write.
        let sandbox_base = codex_home.join(".sandbox");
        ensure_codex_home_exists(&sandbox_base)?;

        let logs_base_dir: Option<&Path> = Some(sandbox_base.as_path());
        log_start(&command, logs_base_dir);
        let combined_read_roots;
        let effective_read_roots_override = if extra_read_roots.is_empty() {
            read_roots_override
        } else {
            let mut roots = read_roots_override
                .map(<[std::path::PathBuf]>::to_vec)
                .unwrap_or_else(|| vec![cwd.to_path_buf()]);
            roots.extend(extra_read_roots.iter().cloned());
            combined_read_roots = Some(roots);
            combined_read_roots.as_deref()
        };
        let sandbox_creds = require_logon_sandbox_creds(
            &policy,
            sandbox_policy_cwd,
            cwd,
            &env_map,
            codex_home,
            effective_read_roots_override,
            read_roots_include_platform_defaults,
            write_roots_override,
            &deny_read_paths_override,
            &deny_write_paths_override,
            proxy_enforced,
        )?;
        // Build capability SID for ACL grants.
        if matches!(
            &policy,
            SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. }
        ) {
            anyhow::bail!("DangerFullAccess and ExternalSandbox are not supported for sandboxing")
        }
        let caps = load_or_create_cap_sids(codex_home)?;
        let (sid_for_null, cap_sids) = match &policy {
            SandboxPolicy::ReadOnly { .. } => {
                let sid = LocalSid::from_string(&caps.readonly)?;
                (sid, vec![caps.readonly])
            }
            SandboxPolicy::WorkspaceWrite { .. } => {
                let write_roots = effective_write_roots_for_setup(
                    &policy,
                    sandbox_policy_cwd,
                    cwd,
                    &env_map,
                    codex_home,
                    write_roots_override,
                );
                let cap_sids = write_roots
                    .iter()
                    .map(|root| workspace_write_cap_sid_for_root(codex_home, cwd, root))
                    .collect::<Result<Vec<_>>>()?;
                if cap_sids.is_empty() {
                    anyhow::bail!("workspace-write sandbox has no writable root capability SIDs");
                }
                (LocalSid::from_string(&cap_sids[0])?, cap_sids)
            }
            SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => {
                unreachable!("DangerFullAccess handled above")
            }
        };

        unsafe {
            allow_null_device(sid_for_null.as_ptr());
        }

        (|| -> Result<CaptureResult> {
            let spawn_request = SpawnRequest {
                command: command.clone(),
                cwd: cwd.to_path_buf(),
                env: env_map.clone(),
                policy_json_or_preset: policy_json_or_preset.to_string(),
                sandbox_policy_cwd: sandbox_policy_cwd.to_path_buf(),
                codex_home: sandbox_base.clone(),
                real_codex_home: codex_home.to_path_buf(),
                cap_sids,
                timeout_ms,
                tty: false,
                stdin_open: false,
                use_private_desktop,
            };
            let transport = spawn_runner_transport(
                codex_home,
                cwd,
                &sandbox_creds,
                logs_base_dir,
                spawn_request,
            )?;
            let (pipe_write, pipe_read) = transport.into_files();
            drop(pipe_write);

            let (exit_code, timed_out, stdout, stderr) = run_capture_io_loop(
                pipe_read,
                Arc::new(Mutex::new(None)),
                Arc::new(AtomicBool::new(false)),
                Arc::new(Mutex::new(None)),
                None,
                None,
            )?;

            if exit_code == 0 {
                log_success(&command, logs_base_dir);
            } else {
                log_failure(&command, &format!("exit code {exit_code}"), logs_base_dir);
            }

            Ok(CaptureResult {
                exit_code,
                stdout,
                stderr,
                timed_out,
            })
        })()
    }

    /// Like [`run_windows_sandbox_capture`], but pushes each Output chunk into live buffers
    /// as it arrives and supports [`StreamingCaptureControl::request_cancel`].
    pub fn run_windows_sandbox_capture_streaming(
        request: ElevatedSandboxCaptureRequest<'_>,
        control: &StreamingCaptureControl,
        live_stdout: Arc<Mutex<Vec<u8>>>,
        live_stderr: Arc<Mutex<Vec<u8>>>,
    ) -> Result<CaptureResult> {
        let ElevatedSandboxCaptureRequest {
            policy_json_or_preset,
            sandbox_policy_cwd,
            codex_home,
            command,
            cwd,
            mut env_map,
            timeout_ms,
            use_private_desktop,
            proxy_enforced,
            read_roots_override,
            read_roots_include_platform_defaults,
            extra_read_roots,
            write_roots_override,
            deny_read_paths_override,
            deny_write_paths_override,
        } = request;
        let deny_read_paths_override = deny_read_paths_override
            .iter()
            .map(AbsolutePathBuf::to_path_buf)
            .collect::<Vec<_>>();
        let deny_write_paths_override = deny_write_paths_override
            .iter()
            .map(AbsolutePathBuf::to_path_buf)
            .collect::<Vec<_>>();
        let policy = parse_policy(policy_json_or_preset)?;
        normalize_null_device_env(&mut env_map);
        ensure_non_interactive_pager(&mut env_map);
        inherit_path_env(&mut env_map);
        inject_git_safe_directory(&mut env_map, cwd);
        let sandbox_base = codex_home.join(".sandbox");
        ensure_codex_home_exists(&sandbox_base)?;

        let logs_base_dir: Option<&Path> = Some(sandbox_base.as_path());
        log_start(&command, logs_base_dir);
        let combined_read_roots;
        let effective_read_roots_override = if extra_read_roots.is_empty() {
            read_roots_override
        } else {
            let mut roots = read_roots_override
                .map(<[std::path::PathBuf]>::to_vec)
                .unwrap_or_else(|| vec![cwd.to_path_buf()]);
            roots.extend(extra_read_roots.iter().cloned());
            combined_read_roots = Some(roots);
            combined_read_roots.as_deref()
        };
        let sandbox_creds = require_logon_sandbox_creds(
            &policy,
            sandbox_policy_cwd,
            cwd,
            &env_map,
            codex_home,
            effective_read_roots_override,
            read_roots_include_platform_defaults,
            write_roots_override,
            &deny_read_paths_override,
            &deny_write_paths_override,
            proxy_enforced,
        )?;
        if matches!(
            &policy,
            SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. }
        ) {
            anyhow::bail!("DangerFullAccess and ExternalSandbox are not supported for sandboxing")
        }
        let caps = load_or_create_cap_sids(codex_home)?;
        let (sid_for_null, cap_sids) = match &policy {
            SandboxPolicy::ReadOnly { .. } => {
                let sid = LocalSid::from_string(&caps.readonly)?;
                (sid, vec![caps.readonly])
            }
            SandboxPolicy::WorkspaceWrite { .. } => {
                let write_roots = effective_write_roots_for_setup(
                    &policy,
                    sandbox_policy_cwd,
                    cwd,
                    &env_map,
                    codex_home,
                    write_roots_override,
                );
                let cap_sids = write_roots
                    .iter()
                    .map(|root| workspace_write_cap_sid_for_root(codex_home, cwd, root))
                    .collect::<Result<Vec<_>>>()?;
                if cap_sids.is_empty() {
                    anyhow::bail!("workspace-write sandbox has no writable root capability SIDs");
                }
                (LocalSid::from_string(&cap_sids[0])?, cap_sids)
            }
            SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => {
                unreachable!("DangerFullAccess handled above")
            }
        };

        unsafe {
            allow_null_device(sid_for_null.as_ptr());
        }

        let spawn_request = SpawnRequest {
            command: command.clone(),
            cwd: cwd.to_path_buf(),
            env: env_map.clone(),
            policy_json_or_preset: policy_json_or_preset.to_string(),
            sandbox_policy_cwd: sandbox_policy_cwd.to_path_buf(),
            codex_home: sandbox_base.clone(),
            real_codex_home: codex_home.to_path_buf(),
            cap_sids,
            timeout_ms,
            tty: false,
            stdin_open: false,
            use_private_desktop,
        };
        let transport = spawn_runner_transport(
            codex_home,
            cwd,
            &sandbox_creds,
            logs_base_dir,
            spawn_request,
        )?;
        let (pipe_write, pipe_read) = transport.into_files();
        *control.pipe_write_holder().lock().unwrap() = Some(pipe_write);

        let (exit_code, timed_out, _, _) = run_capture_io_loop(
            pipe_read,
            control.pipe_write_holder(),
            control.cancelled.clone(),
            control.runner_pid_holder(),
            Some(live_stdout),
            Some(live_stderr),
        )?;

        if exit_code == 0 {
            log_success(&command, logs_base_dir);
        } else {
            log_failure(&command, &format!("exit code {exit_code}"), logs_base_dir);
        }

        Ok(CaptureResult {
            exit_code,
            stdout: Vec::new(),
            stderr: Vec::new(),
            timed_out,
        })
    }

    #[cfg(test)]
    mod tests {
        use crate::policy::SandboxPolicy;

        fn workspace_policy(network_access: bool) -> SandboxPolicy {
            SandboxPolicy::WorkspaceWrite {
                writable_roots: Vec::new(),
                network_access,
                exclude_tmpdir_env_var: false,
                exclude_slash_tmp: false,
            }
        }

        #[test]
        fn applies_network_block_when_access_is_disabled() {
            assert!(!workspace_policy(/*network_access*/ false).has_full_network_access());
        }

        #[test]
        fn skips_network_block_when_access_is_allowed() {
            assert!(workspace_policy(/*network_access*/ true).has_full_network_access());
        }

        #[test]
        fn applies_network_block_for_read_only() {
            assert!(!SandboxPolicy::new_read_only_policy().has_full_network_access());
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::run_windows_sandbox_capture;
#[cfg(target_os = "windows")]
pub use windows_impl::run_windows_sandbox_capture_streaming;
#[cfg(target_os = "windows")]
pub use windows_impl::StreamingCaptureControl;

#[cfg(not(target_os = "windows"))]
mod stub {
    use super::ElevatedSandboxCaptureRequest;
    use anyhow::Result;
    use anyhow::bail;

    #[derive(Debug, Default)]
    pub struct CaptureResult {
        pub exit_code: i32,
        pub stdout: Vec<u8>,
        pub stderr: Vec<u8>,
        pub timed_out: bool,
    }

    /// Stub implementation for non-Windows targets; sandboxing only works on Windows.
    #[allow(clippy::too_many_arguments)]
    pub fn run_windows_sandbox_capture(
        _request: ElevatedSandboxCaptureRequest<'_>,
    ) -> Result<CaptureResult> {
        bail!("Windows sandbox is only available on Windows")
    }
}

#[cfg(not(target_os = "windows"))]
pub use stub::run_windows_sandbox_capture;
