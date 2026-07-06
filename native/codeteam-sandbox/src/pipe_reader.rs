//! Non-blocking stdout/stderr capture for Unix sandbox children.

use std::io::Read;
use std::process::{ChildStderr, ChildStdout};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use crate::attestation::strip_attestation_lines;
use crate::protocol::SandboxEvidence;

pub struct AsyncPipeReader {
    buffer: Arc<Mutex<Vec<u8>>>,
    thread: Option<JoinHandle<()>>,
}

impl AsyncPipeReader {
    pub fn spawn_stdout(mut pipe: ChildStdout) -> Self {
        Self::spawn(move |buf| {
            let mut chunk = [0u8; 65536];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
        })
    }

    pub fn spawn_stderr_with_attestation(
        mut pipe: ChildStderr,
        attestation: Option<Arc<Mutex<Option<SandboxEvidence>>>>,
    ) -> Self {
        Self::spawn(move |buf| {
            let mut chunk = [0u8; 65536];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut guard = buf.lock().unwrap();
                        guard.extend_from_slice(&chunk[..n]);
                        if let Some(slot) = attestation.as_ref() {
                            strip_attestation_lines(&mut guard, &mut |evidence| {
                                *slot.lock().unwrap() = Some(evidence);
                            });
                        }
                    }
                    Err(_) => break,
                }
            }
        })
    }

    fn spawn<F>(reader: F) -> Self
    where
        F: FnOnce(Arc<Mutex<Vec<u8>>>) + Send + 'static,
    {
        let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
        let buf_clone = buffer.clone();
        let thread = thread::spawn(move || reader(buf_clone));
        Self {
            buffer,
            thread: Some(thread),
        }
    }

    pub fn read_chunk(&self, max: usize) -> Vec<u8> {
        let mut guard = self.buffer.lock().unwrap();
        let n = guard.len().min(max);
        guard.drain(..n).collect()
    }

    pub fn join(&mut self) {
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}
