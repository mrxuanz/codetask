#[cfg(target_os = "linux")]
mod bwrap;
pub mod landlock;
pub mod policy_transforms;
#[cfg(target_os = "macos")]
pub mod seatbelt;

#[cfg(target_os = "linux")]
pub use bwrap::find_system_bwrap_in_path;
#[cfg(target_os = "linux")]
pub use bwrap::system_bwrap_warning;

#[cfg(not(target_os = "linux"))]
pub fn system_bwrap_warning(
    _permission_profile: &codeteam_sandbox_policy::models::PermissionProfile,
) -> Option<String> {
    None
}
