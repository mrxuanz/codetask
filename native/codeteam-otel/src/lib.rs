//! Minimal no-op telemetry stubs for sandbox builds without full Codex OTEL stack.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsigMetricsSettings {
    #[serde(default)]
    pub environment: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtelExporter {
    Disabled,
    Statsig,
}

#[derive(Debug, Clone)]
pub struct OtelSettings {
    pub environment: String,
    pub service_name: String,
    pub service_version: String,
    pub codex_home: PathBuf,
    pub exporter: OtelExporter,
    pub trace_exporter: OtelExporter,
    pub metrics_exporter: OtelExporter,
    pub runtime_metrics: bool,
    pub span_attributes: BTreeMap<String, String>,
    pub tracestate: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct OtelProvider;

#[derive(Debug, Clone, Default)]
pub struct OtelMetrics;

impl OtelProvider {
    pub fn from(_settings: &OtelSettings) -> Result<Self, String> {
        Ok(Self)
    }

    pub fn metrics(&self) -> Option<OtelMetrics> {
        None
    }

    pub fn shutdown(self) {}
}

impl OtelMetrics {
    pub fn counter(&self, _name: &str, _inc: u64, _tags: &[(&str, &str)]) -> Result<(), String> {
        Ok(())
    }
}

pub fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings> {
    None
}
