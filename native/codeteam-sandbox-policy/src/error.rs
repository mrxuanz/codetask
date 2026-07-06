use std::io;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, CodexErr>;

#[derive(Error, Debug)]
pub enum SandboxErr {
    #[error("Landlock was not able to fully enforce all sandbox rules")]
    LandlockRestrict,

    #[cfg(target_os = "linux")]
    #[error("seccomp setup error")]
    SeccompInstall(#[from] seccompiler::Error),

    #[cfg(target_os = "linux")]
    #[error("seccomp backend error")]
    SeccompBackend(#[from] seccompiler::BackendError),
}

#[derive(Error, Debug)]
pub enum CodexErr {
    #[error("Fatal error: {0}")]
    Fatal(String),
    #[error("unsupported operation: {0}")]
    UnsupportedOperation(String),
    #[error("sandbox error: {0}")]
    Sandbox(#[from] SandboxErr),
    #[error("codeteam-linux-sandbox was required but not provided")]
    LandlockSandboxExecutableNotProvided,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[cfg(target_os = "linux")]
    #[error(transparent)]
    LandlockRuleset(#[from] landlock::RulesetError),
    #[cfg(target_os = "linux")]
    #[error(transparent)]
    LandlockPathFd(#[from] landlock::PathFdError),
}
