//! Stub network proxy surface for Seatbelt policy generation when managed proxy is disabled.

use std::collections::HashMap;
use std::sync::Arc;

pub const PROXY_URL_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "WS_PROXY",
    "WSS_PROXY",
    "ALL_PROXY",
    "FTP_PROXY",
    "YARN_HTTP_PROXY",
    "YARN_HTTPS_PROXY",
    "NPM_CONFIG_HTTP_PROXY",
    "NPM_CONFIG_HTTPS_PROXY",
    "NPM_CONFIG_PROXY",
    "BUNDLE_HTTP_PROXY",
    "BUNDLE_HTTPS_PROXY",
    "PIP_PROXY",
    "DOCKER_HTTP_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

#[derive(Debug, Clone, Default)]
pub struct NetworkProxy;

#[derive(Debug, Clone, Default)]
pub struct NetworkProxyConfig;

#[derive(Debug, Clone, Default)]
pub struct NetworkProxyConstraints;

#[derive(Debug, Clone, Default)]
pub struct NetworkProxyState;

#[derive(Debug, Clone, Default)]
pub struct ConfigState;

#[derive(Debug, Clone, Default)]
pub struct ConfigReloader;

#[derive(Debug, Clone, Copy, Default)]
pub enum NetworkMode {
    #[default]
    Disabled,
}

pub fn proxy_url_env_value<'a>(
    env: &'a HashMap<String, String>,
    canonical_key: &str,
) -> Option<&'a str> {
    if let Some(value) = env.get(canonical_key) {
        return Some(value.as_str());
    }
    let lower_key = canonical_key.to_ascii_lowercase();
    env.get(lower_key.as_str()).map(String::as_str)
}

pub fn has_proxy_url_env_vars(env: &HashMap<String, String>) -> bool {
    PROXY_URL_ENV_KEYS
        .iter()
        .any(|key| proxy_url_env_value(env, key).is_some_and(|value| !value.trim().is_empty()))
}

pub fn build_config_state(_config: &NetworkProxyConfig) -> ConfigState {
    ConfigState
}

impl NetworkProxy {
    pub fn builder() -> NetworkProxyBuilder {
        NetworkProxyBuilder
    }

    pub fn apply_to_env(&self, _env: &mut HashMap<String, String>) {}

    pub fn dangerously_allow_all_unix_sockets(&self) -> bool {
        false
    }

    pub fn allow_unix_sockets(&self) -> Arc<[String]> {
        Arc::from([])
    }

    pub fn allow_local_binding(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Default)]
pub struct NetworkProxyBuilder;

impl NetworkProxyBuilder {
    pub fn build(self) -> NetworkProxy {
        NetworkProxy
    }
}
