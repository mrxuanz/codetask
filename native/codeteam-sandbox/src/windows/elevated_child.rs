//! Windows elevated sandbox spawn via desktop host + NAPI runner IPC.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use codeteam_sandbox_adapter::{legacy_policy_json, parse_task_policy_json, ParsedTaskPolicy};
use codeteam_windows_sandbox::{
    apply_electron_node_env, resolve_host_launcher, run_windows_sandbox_capture_streaming_elevated,
    sandbox_setup_is_complete, ElevatedSandboxCaptureRequest, StreamingCaptureControl,
};

use crate::attestation::{wrap_windows_command, ATTESTATION_EMITTER_SCRIPT};
use crate::protocol::{SandboxEvidence, SandboxPolicy};
use crate::windows::setup::resolve_sandbox_home;

struct RunningState {
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    exit_code: Arc<Mutex<Option<i32>>>,
    control: StreamingCaptureControl,
    join: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct ElevatedChild {
    policy_json: String,
    command: Vec<String>,
    cwd: PathBuf,
    runtime_root: PathBuf,
    sandbox_home: PathBuf,
    env_map: HashMap<String, String>,
    allowed_read_roots: Vec<PathBuf>,
    allowed_write_roots: Vec<PathBuf>,
    allow_system_runtime: bool,
    stdin_buffer: Vec<u8>,
    started: bool,
    running: Option<RunningState>,
}

impl ElevatedChild {
    pub fn spawn(
        policy: &SandboxPolicy,
        policy_json: &str,
        _parsed: &ParsedTaskPolicy,
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
        allowed_read_roots: &[PathBuf],
        allowed_write_roots: &[PathBuf],
        allow_system_runtime: bool,
    ) -> anyhow::Result<Self> {
        let sandbox_home = resolve_sandbox_home(None);
        if !sandbox_setup_is_complete(&sandbox_home) {
            anyhow::bail!("windows sandbox setup incomplete; run setup at application startup");
        }
        let host_launcher = resolve_host_launcher(&sandbox_home).ok_or_else(|| {
            anyhow::anyhow!(
                "desktop host launcher not registered; call windowsSetup at application startup"
            )
        })?;

        let task_policy = parse_task_policy_json(policy_json)?;
        let legacy_json = legacy_policy_json(&task_policy)?;
        let runtime_root = PathBuf::from(policy.runtime_root());
        let emitter_script = runtime_root.join(ATTESTATION_EMITTER_SCRIPT);
        let node_exe = if command.to_ascii_lowercase().ends_with("node.exe")
            || command.to_ascii_lowercase().ends_with("electron.exe")
            || Path::new(command).file_name().and_then(|n| n.to_str()) == Some("node")
        {
            command.to_string()
        } else {
            host_launcher
                .host_exe
                .to_string_lossy()
                .into_owned()
        };
        let (wrapped_command, wrapped_args) =
            wrap_windows_command(&node_exe, &emitter_script, command, args);

        Ok(Self {
            policy_json: legacy_json,
            command: {
                let mut cmd = vec![wrapped_command];
                cmd.extend(wrapped_args);
                cmd
            },
            cwd: PathBuf::from(policy.cwd()),
            runtime_root,
            sandbox_home,
            env_map: {
                let mut env_map = env.clone();
                env_map.insert("CODETASK_OUTER_SANDBOX".to_string(), "1".to_string());
                env_map.insert(
                    "CODETASK_RUNTIME_ROOT".to_string(),
                    policy.runtime_root().to_string(),
                );
                apply_electron_node_env(&mut env_map);
                env_map
            },
            allowed_read_roots: allowed_read_roots.to_vec(),
            allowed_write_roots: allowed_write_roots.to_vec(),
            allow_system_runtime,
            stdin_buffer: Vec::new(),
            started: false,
            running: None,
        })
    }

    fn ensure_started(&mut self) -> anyhow::Result<()> {
        if self.started {
            return Ok(());
        }
        self.started = true;

        if !self.stdin_buffer.is_empty() {
            let input_path = self.runtime_root.join("worker-input.json");
            fs::write(&input_path, &self.stdin_buffer)?;
            self.env_map.insert(
                "CODETASK_WORKER_INPUT_FILE".to_string(),
                input_path.to_string_lossy().into_owned(),
            );
        }

        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let exit_code = Arc::new(Mutex::new(None));
        let control = StreamingCaptureControl::new();

        let stdout_t = stdout.clone();
        let stderr_t = stderr.clone();
        let exit_t = exit_code.clone();
        let control_t = control.clone();

        let policy_json = self.policy_json.clone();
        let command = self.command.clone();
        let cwd = self.cwd.clone();
        let sandbox_home = self.sandbox_home.clone();
        let env_map = self.env_map.clone();
        let allowed_read_roots = self.allowed_read_roots.clone();
        let allowed_write_roots = self.allowed_write_roots.clone();
        let allow_system_runtime = self.allow_system_runtime;

        let join = thread::spawn(move || -> anyhow::Result<()> {
            let sandbox_policy_cwd = cwd.clone();
            let write_roots_override = if allowed_write_roots.is_empty() {
                None
            } else {
                Some(allowed_write_roots.as_slice())
            };
            let request = ElevatedSandboxCaptureRequest {
                policy_json_or_preset: &policy_json,
                sandbox_policy_cwd: &sandbox_policy_cwd,
                codex_home: &sandbox_home,
                command,
                cwd: &cwd,
                env_map,
                timeout_ms: None,
                use_private_desktop: false,
                proxy_enforced: false,
                read_roots_override: if allowed_read_roots.is_empty() {
                    None
                } else {
                    Some(allowed_read_roots.as_slice())
                },
                read_roots_include_platform_defaults: allow_system_runtime,
                extra_read_roots: &[],
                write_roots_override,
                deny_read_paths_override: &[],
                deny_write_paths_override: &[],
            };
            let result = run_windows_sandbox_capture_streaming_elevated(
                request,
                &control_t,
                stdout_t,
                stderr_t,
            )?;
            *exit_t.lock().unwrap() = Some(result.exit_code);
            Ok(())
        });

        self.running = Some(RunningState {
            stdout,
            stderr,
            exit_code,
            control,
            join: Some(join),
        });
        Ok(())
    }

    pub fn try_collect_attestation(&self) -> Option<SandboxEvidence> {
        let running = self.running.as_ref()?;
        let mut guard = running.stderr.lock().unwrap();
        let mut found = None;
        crate::attestation::strip_attestation_lines(&mut guard, &mut |evidence| {
            found = Some(evidence);
        });
        found
    }

    pub fn id(&self) -> u32 {
        std::process::id()
    }

    pub fn write_stdin(&mut self, data: &[u8]) -> anyhow::Result<()> {
        if !self.started {
            self.stdin_buffer.extend_from_slice(data);
        }
        Ok(())
    }

    pub fn end_stdin(&mut self) -> anyhow::Result<()> {
        self.ensure_started()
    }

    pub fn read_stdout_chunk(&mut self, max: usize) -> Vec<u8> {
        let Some(running) = self.running.as_ref() else {
            return Vec::new();
        };
        drain_chunk(&running.stdout, max)
    }

    pub fn read_stderr_chunk(&mut self, max: usize) -> Vec<u8> {
        let Some(running) = self.running.as_ref() else {
            return Vec::new();
        };
        drain_chunk(&running.stderr, max)
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        if let Some(running) = self.running.as_mut() {
            running.control.request_cancel();
            running
                .stderr
                .lock()
                .unwrap()
                .extend_from_slice(b"sandbox session cancel requested\n");
        }
        Ok(())
    }

    pub fn poll_exit(&mut self) -> Option<i32> {
        let Some(running) = self.running.as_mut() else {
            return None;
        };
        if let Some(code) = *running.exit_code.lock().unwrap() {
            return Some(code);
        }
        if let Some(join) = running.join.take() {
            match join.join() {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    running
                        .stderr
                        .lock()
                        .unwrap()
                        .extend_from_slice(format!("{err}\n").as_bytes());
                }
                Err(_) => {
                    running
                        .stderr
                        .lock()
                        .unwrap()
                        .extend_from_slice(b"sandbox thread panicked\n");
                }
            }
            return running.exit_code.lock().unwrap().or(Some(-1));
        }
        None
    }

    pub fn wait(&mut self) -> anyhow::Result<i32> {
        loop {
            if let Some(code) = self.poll_exit() {
                return Ok(code);
            }
            thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    pub fn close(&mut self) {
        if let Some(mut running) = self.running.take() {
            running.control.request_cancel();
            if let Some(join) = running.join.take() {
                let _ = join.join();
            }
        }
    }
}

pub fn preflight() -> anyhow::Result<()> {
    let home = resolve_sandbox_home(None);
    if !sandbox_setup_is_complete(&home) {
        anyhow::bail!("windows sandbox setup incomplete");
    }
    if resolve_host_launcher(&home).is_none() {
        anyhow::bail!("desktop host launcher not registered");
    }
    Ok(())
}

fn drain_chunk(buffer: &Arc<Mutex<Vec<u8>>>, max: usize) -> Vec<u8> {
    let mut guard = buffer.lock().unwrap();
    let n = guard.len().min(max);
    guard.drain(..n).collect()
}
