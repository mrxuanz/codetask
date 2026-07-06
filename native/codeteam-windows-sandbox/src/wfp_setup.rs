use crate::install_wfp_filters_for_account;
use anyhow::Result;
use codeteam_otel::StatsigMetricsSettings;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
enum WfpSetupMetricOutcome {
    Success,
    Failure,
}

#[allow(dead_code)]
struct WfpSetupMetric {
    outcome: WfpSetupMetricOutcome,
    target_account: String,
    installed_filter_count: usize,
    error: Option<String>,
}

fn panic_payload_to_string(panic_payload: Box<dyn std::any::Any + Send>) -> String {
    match panic_payload.downcast::<String>() {
        Ok(message) => *message,
        Err(panic_payload) => match panic_payload.downcast::<&'static str>() {
            Ok(message) => (*message).to_string(),
            Err(_) => "unknown panic payload".to_string(),
        },
    }
}

fn emit_wfp_setup_metric(
    _codex_home: &Path,
    _otel: Option<&StatsigMetricsSettings>,
    _metric: &WfpSetupMetric,
) -> Result<()> {
    Ok(())
}

fn emit_wfp_setup_metric_safely<F>(
    codex_home: &Path,
    otel: Option<&StatsigMetricsSettings>,
    offline_username: &str,
    metric: &WfpSetupMetric,
    log: &mut F,
) where
    F: FnMut(&str),
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        emit_wfp_setup_metric(codex_home, otel, metric)
    }));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => log(&format!(
            "failed to emit WFP setup metric for {offline_username}: {err}"
        )),
        Err(panic_payload) => {
            let error = panic_payload_to_string(panic_payload);
            log(&format!(
                "WFP setup metric emission panicked for {offline_username}: {error}"
            ));
        }
    }
}

pub fn install_wfp_filters<F>(
    codex_home: &Path,
    offline_username: &str,
    otel: Option<&StatsigMetricsSettings>,
    mut log: F,
) where
    F: FnMut(&str),
{
    let metric = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        install_wfp_filters_for_account(offline_username)
    })) {
        Ok(Ok(installed_filter_count)) => {
            log(&format!(
                "WFP setup succeeded for {offline_username} with {installed_filter_count} installed filters"
            ));
            WfpSetupMetric {
                outcome: WfpSetupMetricOutcome::Success,
                target_account: offline_username.to_string(),
                installed_filter_count,
                error: None,
            }
        }
        Ok(Err(err)) => {
            let error = err.to_string();
            log(&format!(
                "WFP setup failed for {offline_username}: {error}; continuing elevated setup"
            ));
            WfpSetupMetric {
                outcome: WfpSetupMetricOutcome::Failure,
                target_account: offline_username.to_string(),
                installed_filter_count: 0,
                error: Some(error),
            }
        }
        Err(panic_payload) => {
            let error = panic_payload_to_string(panic_payload);
            log(&format!(
                "WFP setup panicked for {offline_username}: {error}; continuing elevated setup"
            ));
            WfpSetupMetric {
                outcome: WfpSetupMetricOutcome::Failure,
                target_account: offline_username.to_string(),
                installed_filter_count: 0,
                error: Some(format!("panic: {error}")),
            }
        }
    };

    emit_wfp_setup_metric_safely(codex_home, otel, offline_username, &metric, &mut log);
}
