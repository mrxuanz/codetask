use codeteam_sandbox_policy::permissions::FileSystemSandboxKind;
use codeteam_sandbox_policy::permissions::FileSystemSandboxPolicy;
use codeteam_sandbox_policy::permissions::NetworkSandboxPolicy;

pub fn should_require_platform_sandbox(
    file_system_policy: &FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    has_managed_network_requirements: bool,
) -> bool {
    if has_managed_network_requirements {
        return true;
    }

    if !network_policy.is_enabled() {
        return !matches!(
            file_system_policy.kind,
            FileSystemSandboxKind::ExternalSandbox
        );
    }

    match file_system_policy.kind {
        FileSystemSandboxKind::Restricted => !file_system_policy.has_full_disk_write_access(),
        FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => false,
    }
}

#[cfg(test)]
#[path = "policy_transforms_tests.rs"]
mod tests;
