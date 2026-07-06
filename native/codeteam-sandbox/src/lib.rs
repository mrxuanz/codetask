#![allow(clippy::all)]

mod helper;
mod protocol;
mod spawn;

mod attestation;
#[cfg(not(windows))]
mod pipe_reader;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use std::io::Write;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use protocol::SandboxPolicy;

#[napi(object)]
#[derive(Clone)]
pub struct SandboxEvidenceJs {
    pub protocol_version: u32,
    pub active: bool,
    pub backend: String,
    pub policy_sha256: String,
    pub sandbox_pid: u32,
    pub effective_read_roots_hash: Option<String>,
    pub effective_write_roots_hash: Option<String>,
    pub warnings: Vec<String>,
}

#[napi(object)]
pub struct EnvPair {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct LaunchSandboxOptions {
    pub policy_json: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Option<Vec<EnvPair>>,
    pub read_roots: Option<Vec<String>>,
    pub write_roots: Option<Vec<String>>,
}

enum SandboxChildInner {
    #[cfg(not(windows))]
    Os {
        child: std::process::Child,
        stdout: pipe_reader::AsyncPipeReader,
        stderr: pipe_reader::AsyncPipeReader,
    },
    #[cfg(windows)]
    Windows(windows::elevated_child::ElevatedChild),
}

#[napi]
pub struct SandboxChild {
    inner: Mutex<Option<SandboxChildInner>>,
    evidence: Mutex<SandboxEvidenceJs>,
    helper_attestation: Arc<Mutex<Option<protocol::SandboxEvidence>>>,
    expected_policy_sha256: String,
}

fn policy_from_json(json: &str) -> Result<SandboxPolicy> {
    protocol::parse_policy_json(json).map_err(|e| Error::from_reason(e.to_string()))
}

fn env_map(pairs: Option<Vec<EnvPair>>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(pairs) = pairs {
        for pair in pairs {
            map.insert(pair.key, pair.value);
        }
    }
    map
}

fn evidence_to_js(evidence: protocol::SandboxEvidence) -> SandboxEvidenceJs {
    SandboxEvidenceJs {
        protocol_version: evidence.protocol_version,
        active: evidence.active,
        backend: evidence.backend,
        policy_sha256: evidence.policy_sha256,
        sandbox_pid: evidence.sandbox_pid,
        effective_read_roots_hash: evidence.effective_read_roots_hash,
        effective_write_roots_hash: evidence.effective_write_roots_hash,
        warnings: evidence.warnings,
    }
}

#[napi]
pub fn preflight() -> Result<()> {
    spawn::preflight_all().map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_helper_path() -> Result<String> {
    helper::resolve_helper_path().map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn helper_version() -> Result<String> {
    Ok(helper::helper_version().to_string())
}

#[napi]
pub fn run_self_test() -> Result<()> {
    helper::run_self_test().map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn windows_setup_status(sandbox_home: Option<String>) -> Result<bool> {
    #[cfg(windows)]
    {
        return Ok(windows::setup_is_complete(&windows::resolve_sandbox_home(
            sandbox_home.as_deref(),
        )));
    }
    #[cfg(not(windows))]
    {
        let _ = sandbox_home;
        Ok(true)
    }
}

#[napi]
pub fn windows_setup(
    node_exe: String,
    setup_script: String,
    runner_script: String,
    sandbox_home: String,
    policy_cwd: String,
) -> Result<()> {
    #[cfg(windows)]
    {
        return windows::setup(
            &node_exe,
            &setup_script,
            &runner_script,
            &sandbox_home,
            &policy_cwd,
        )
        .map_err(|e| Error::from_reason(e.to_string()));
    }
    #[cfg(not(windows))]
    {
        let _ = (
            node_exe,
            setup_script,
            runner_script,
            sandbox_home,
            policy_cwd,
        );
        Ok(())
    }
}

#[napi]
pub fn run_setup_helper(payload_b64: String) -> Result<()> {
    #[cfg(windows)]
    {
        return windows::run_setup_helper(&payload_b64)
            .map_err(|e| Error::from_reason(e.to_string()));
    }
    #[cfg(not(windows))]
    {
        let _ = payload_b64;
        Ok(())
    }
}

#[napi]
pub fn run_command_runner(args: Vec<String>) -> Result<()> {
    #[cfg(windows)]
    {
        return windows::run_command_runner(args).map_err(|e| Error::from_reason(e.to_string()));
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        Ok(())
    }
}

#[napi]
pub fn launch_sandboxed_worker(options: LaunchSandboxOptions) -> Result<SandboxChild> {
    let policy = policy_from_json(&options.policy_json)?;
    let env = env_map(options.env);
    let spawned = spawn::spawn_sandboxed(
        policy,
        &options.policy_json,
        &options.command,
        &options.args,
        &env,
    )
    .map_err(|e| Error::from_reason(e.to_string()))?;

    let evidence = evidence_to_js(spawned.evidence);
    let expected_policy_sha256 = evidence.policy_sha256.clone();

    let helper_attestation = Arc::new(Mutex::new(None));

    #[cfg(windows)]
    let inner = SandboxChildInner::Windows(spawned.child);

    #[cfg(not(windows))]
    let inner = {
        let mut child = spawned.child;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::from_reason("stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::from_reason("stderr unavailable"))?;
        let stderr_reader = pipe_reader::AsyncPipeReader::spawn_stderr_with_attestation(
            stderr,
            Some(helper_attestation.clone()),
        );
        SandboxChildInner::Os {
            child,
            stdout: pipe_reader::AsyncPipeReader::spawn_stdout(stdout),
            stderr: stderr_reader,
        }
    };

    Ok(SandboxChild {
        inner: Mutex::new(Some(inner)),
        evidence: Mutex::new(evidence),
        helper_attestation,
        expected_policy_sha256,
    })
}

#[napi]
impl SandboxChild {
    #[napi(getter)]
    pub fn pid(&self) -> Result<u32> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        Ok(match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { child, .. } => child.id(),
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => child.id(),
        })
    }

    #[napi(getter)]
    pub fn evidence(&self) -> Result<SandboxEvidenceJs> {
        Ok(self
            .evidence
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?
            .clone())
    }

    #[napi]
    pub fn wait_for_attestation(&self, timeout_ms: Option<u32>) -> Result<bool> {
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000) as u64);
        let deadline = Instant::now() + timeout;

        while Instant::now() < deadline {
            if let Some(helper_evidence) = self
                .helper_attestation
                .lock()
                .map_err(|_| Error::from_reason("lock poisoned"))?
                .clone()
            {
                if helper_evidence.policy_sha256 != self.expected_policy_sha256 {
                    return Err(Error::from_reason(
                        "sandbox helper attestation policy hash mismatch",
                    ));
                }
                let mut evidence = self
                    .evidence
                    .lock()
                    .map_err(|_| Error::from_reason("lock poisoned"))?;
                *evidence = evidence_to_js(helper_evidence);
                return Ok(true);
            }

            #[cfg(windows)]
            {
                let mut guard = self
                    .inner
                    .lock()
                    .map_err(|_| Error::from_reason("lock poisoned"))?;
                if let Some(SandboxChildInner::Windows(child)) = guard.as_mut() {
                    if let Some(helper_evidence) = child.try_collect_attestation() {
                        if helper_evidence.policy_sha256 != self.expected_policy_sha256 {
                            return Err(Error::from_reason(
                                "sandbox helper attestation policy hash mismatch",
                            ));
                        }
                        *self
                            .helper_attestation
                            .lock()
                            .map_err(|_| Error::from_reason("lock poisoned"))? =
                            Some(helper_evidence.clone());
                        let mut evidence = self
                            .evidence
                            .lock()
                            .map_err(|_| Error::from_reason("lock poisoned"))?;
                        *evidence = evidence_to_js(helper_evidence);
                        return Ok(true);
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(false)
    }

    #[napi]
    pub fn write_stdin(&self, data: Buffer) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { child, .. } => {
                let stdin = child
                    .stdin
                    .as_mut()
                    .ok_or_else(|| Error::from_reason("stdin unavailable"))?;
                stdin
                    .write_all(data.as_ref())
                    .map_err(|e| Error::from_reason(e.to_string()))
            }
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => child
                .write_stdin(data.as_ref())
                .map_err(|e| Error::from_reason(e.to_string())),
        }
    }

    #[napi]
    pub fn end_stdin(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { child, .. } => {
                child.stdin.take();
                Ok(())
            }
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => child
                .end_stdin()
                .map_err(|e| Error::from_reason(e.to_string())),
        }
    }

    #[napi]
    pub fn read_stdout_chunk(&self, max_bytes: Option<u32>) -> Result<Buffer> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        let max = max_bytes.unwrap_or(64 * 1024) as usize;
        match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { stdout, .. } => Ok(Buffer::from(stdout.read_chunk(max))),
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => Ok(Buffer::from(child.read_stdout_chunk(max))),
        }
    }

    #[napi]
    pub fn read_stderr_chunk(&self, max_bytes: Option<u32>) -> Result<Buffer> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        let max = max_bytes.unwrap_or(64 * 1024) as usize;
        match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { stderr, .. } => Ok(Buffer::from(stderr.read_chunk(max))),
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => Ok(Buffer::from(child.read_stderr_chunk(max))),
        }
    }

    #[napi]
    pub fn kill(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        if let Some(inner) = guard.as_mut() {
            match inner {
                #[cfg(not(windows))]
                SandboxChildInner::Os { child, stdout, stderr } => {
                    let _ = child.kill();
                    stdout.join();
                    stderr.join();
                }
                #[cfg(windows)]
                SandboxChildInner::Windows(child) => {
                    let _ = child.kill();
                }
            }
        }
        Ok(())
    }

    #[napi]
    pub fn poll_exit(&self) -> Result<Option<i32>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        let code = match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { child, stdout, stderr } => match child.try_wait() {
                Ok(Some(status)) => {
                    stdout.join();
                    stderr.join();
                    Some(status.code().unwrap_or(-1))
                }
                Ok(None) => None,
                Err(err) => return Err(Error::from_reason(err.to_string())),
            },
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => child.poll_exit(),
        };
        Ok(code)
    }

    #[napi]
    pub fn wait(&self) -> Result<i32> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        let inner = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("sandbox child closed"))?;
        let code = match inner {
            #[cfg(not(windows))]
            SandboxChildInner::Os { child, stdout, stderr } => {
                let status = child
                    .wait()
                    .map_err(|e| Error::from_reason(e.to_string()))?;
                stdout.join();
                stderr.join();
                status.code().unwrap_or(-1)
            }
            #[cfg(windows)]
            SandboxChildInner::Windows(child) => child
                .wait()
                .map_err(|e| Error::from_reason(e.to_string()))?,
        };
        Ok(code)
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("lock poisoned"))?;
        if let Some(inner) = guard.take() {
            match inner {
                #[cfg(not(windows))]
                SandboxChildInner::Os { mut child, mut stdout, mut stderr } => {
                    let _ = child.kill();
                    let _ = child.wait();
                    stdout.join();
                    stderr.join();
                }
                #[cfg(windows)]
                SandboxChildInner::Windows(mut child) => child.close(),
            }
        }
        Ok(())
    }
}
