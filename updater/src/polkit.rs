use crate::builder::PackageFormat;
use std::fs;
use std::path::Path;
use std::process::Command;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    InstallDeb,
    InstallRpm,
    InstallValidatedPackage,
}

impl Action {
    pub fn for_install(format: PackageFormat, unattended: bool) -> Self {
        if unattended {
            Self::InstallValidatedPackage
        } else {
            match format {
                PackageFormat::Deb => Self::InstallDeb,
                PackageFormat::Rpm => Self::InstallRpm,
            }
        }
    }

    pub fn policy_id(self) -> &'static str {
        match self {
            Self::InstallDeb => "org.factory.desktop.update-manager.install-deb",
            Self::InstallRpm => "org.factory.desktop.update-manager.install-rpm",
            Self::InstallValidatedPackage => {
                "org.factory.desktop.update-manager.install-validated-package"
            }
        }
    }

    pub fn command(self) -> &'static str {
        match self {
            Self::InstallDeb => "install-deb",
            Self::InstallRpm => "install-rpm",
            Self::InstallValidatedPackage => "install-validated-package",
        }
    }
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
