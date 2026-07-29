//! Centralized filesystem layout for the update manager's own state,
//! separate from the Node build pipeline's repository-relative paths.
//!
//! All paths are rooted under XDG-style user directories so the daemon
//! never needs root to run:
//!
//! - `~/.config/factory-update-manager/config.toml` (not yet used; reserved)
//! - `~/.local/state/factory-update-manager/state.json`
//! - `~/.local/state/factory-update-manager/state.lock`
//! - `~/.cache/factory-update-manager/downloads/Factory-<sha256>.dmg`
//! - `~/.cache/factory-update-manager/workspaces/<candidate-id>/`

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Resolves the base directories the update manager owns, honoring
/// `XDG_STATE_HOME` / `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` when set, and
/// falling back to the conventional `~/.local/state`, `~/.cache`,
/// `~/.config` locations otherwise.
#[derive(Debug, Clone)]
pub struct Paths {
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub config_dir: PathBuf,
}

impl Paths {
    /// Resolve paths from the environment. `root_override` lets tests pin
    /// every directory under a single temporary root without touching the
    /// real `$HOME`.
    pub fn resolve(root_override: Option<&Path>) -> io::Result<Self> {
        if let Some(root) = root_override {
            return Ok(Self {
                state_dir: root.join("state"),
                cache_dir: root.join("cache"),
                config_dir: root.join("config"),
            });
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "HOME is not set and no path override was supplied",
            )
        })?;
        let state_dir = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("state"))
            .join("factory-update-manager");
        let cache_dir = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"))
            .join("factory-update-manager");
        let config_dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("factory-update-manager");
        Ok(Self {
            state_dir,
            cache_dir,
            config_dir,
        })
    }

    pub fn state_file(&self) -> PathBuf {
        self.state_dir.join("state.json")
    }

    pub fn state_lock_file(&self) -> PathBuf {
        self.state_dir.join("state.lock")
    }

    pub fn downloads_dir(&self) -> PathBuf {
        self.cache_dir.join("downloads")
    }

    pub fn workspaces_dir(&self) -> PathBuf {
        self.cache_dir.join("workspaces")
    }

    pub fn known_good_dir(&self) -> PathBuf {
        self.state_dir.join("known-good")
    }

    pub fn service_log_file(&self) -> PathBuf {
        self.state_dir.join("service.log")
    }

    pub fn ensure_all(&self) -> std::io::Result<()> {
        for directory in [
            self.state_dir.clone(),
            self.cache_dir.clone(),
            self.config_dir.clone(),
            self.downloads_dir(),
            self.workspaces_dir(),
            self.known_good_dir(),
        ] {
            std::fs::create_dir_all(&directory)?;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}
