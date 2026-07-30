use crate::builder::PackageFormat;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::process::Command;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    InstallDeb,
    InstallRpm,
    ApproveCandidate,
    InstallApprovedPackage,
}

impl Action {
    pub fn for_install(format: PackageFormat, _unattended: bool) -> Self {
        match format {
            PackageFormat::Deb => Self::InstallDeb,
            PackageFormat::Rpm => Self::InstallRpm,
        }
    }

    pub fn policy_id(self) -> &'static str {
        match self {
            Self::InstallDeb => "org.factory.desktop.update-manager.install-deb",
            Self::InstallRpm => "org.factory.desktop.update-manager.install-rpm",
            Self::ApproveCandidate => "org.factory.desktop.update-manager.approve-candidate",
            Self::InstallApprovedPackage => {
                "org.factory.desktop.update-manager.install-approved-package"
            }
        }
    }

    pub fn command(self) -> &'static str {
        match self {
            Self::InstallDeb => "install-deb",
            Self::InstallRpm => "install-rpm",
            Self::ApproveCandidate => "approve-candidate",
            Self::InstallApprovedPackage => "install-approved-package",
        }
    }
}

pub fn write_unattended_opt_in(config: &Path) -> Result<(), Error> {
    let parent = config.parent().ok_or("config path has no parent")?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let existing = fs::read_to_string(config).unwrap_or_default();
    let mut found = false;
    let mut lines = Vec::new();
    for line in existing.lines() {
        if line
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .starts_with("unattended")
        {
            if found {
                continue;
            }
            lines.push("unattended = true".to_owned());
            found = true;
        } else {
            lines.push(line.to_owned());
        }
    }
    if !found {
        lines.push("unattended = true".to_owned());
    }
    let partial = parent.join(format!(".config-{}.partial", std::process::id()));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&partial)?;
    let result = (|| -> std::io::Result<()> {
        output.write_all(lines.join("\n").as_bytes())?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        fs::rename(&partial, config)?;
        fs::set_permissions(config, fs::Permissions::from_mode(0o600))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(())
}

pub fn read_unattended(config: &Path) -> Result<bool, Error> {
    if !config.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(config)?;
    let mut value = false;
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        if let Some(candidate) = line.strip_prefix("unattended") {
            let setting = candidate
                .trim()
                .strip_prefix('=')
                .map(str::trim)
                .ok_or("invalid unattended configuration")?;
            value = match setting {
                "true" => true,
                "false" => false,
                _ => return Err("unattended must be true or false".into()),
            };
        }
    }
    Ok(value)
}

pub fn request_polkit_install(
    action: Action,
    manager_binary: &Path,
    manifest: &Path,
) -> Result<String, Error> {
    let output = Command::new("pkexec")
        .arg(manager_binary)
        .arg(action.command())
        .arg(manifest)
        .output()?;
    if !output.status.success() {
        return Err(format!("polkit action {} was not authorized", action.policy_id()).into());
    }
    Ok(String::from_utf8(output.stdout)?)
}
