pub mod config_types;
pub mod error;
pub mod legacy;
pub mod permissions;

pub mod models {
    include!("models_profile.rs");
}

pub mod protocol {
    pub use crate::legacy::*;
    pub use crate::permissions::{
        FileSystemAccessMode, FileSystemPath, FileSystemSandboxEntry, FileSystemSandboxKind,
        FileSystemSandboxPolicy, FileSystemSpecialPath, NetworkSandboxPolicy,
        PROTECTED_METADATA_PATH_NAMES,
    };
}

pub use legacy::{NetworkAccess, SandboxPolicy, WritableRoot};
pub use models::PermissionProfile;
pub use permissions::*;
