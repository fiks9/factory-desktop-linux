use crate::builder::PackageFormat;
use std::path::Path;
use std::process::Command;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub trait PackageManager {
    fn format(&self) -> PackageFormat;
    fn installed_version(&self) -> Result<Option<String>, Error>;
    fn install(&self, package: &Path) -> Result<(), Error>;
}

#[derive(Debug, Clone, Copy)]
pub enum NativePackageManager {
    Deb,
    Rpm,
}

impl NativePackageManager {
    pub fn detect() -> Result<Self, Error> {
        if Command::new("dpkg-query")
            .args(["-W", "-f=${Version}", "factory-desktop"])
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return Ok(Self::Deb);
        }
        if Command::new("rpm")
            .args(["-q", "factory-desktop"])
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return Ok(Self::Rpm);
        }
        Err("Factory Desktop is not installed through a supported package manager".into())
    }

    pub fn for_format(format: PackageFormat) -> Self {
        match format {
            PackageFormat::Deb => Self::Deb,
            PackageFormat::Rpm => Self::Rpm,
        }
    }
}

impl PackageManager for NativePackageManager {
    fn format(&self) -> PackageFormat {
        match self {
            Self::Deb => PackageFormat::Deb,
            Self::Rpm => PackageFormat::Rpm,
        }
    }

    fn installed_version(&self) -> Result<Option<String>, Error> {
        let output = match self {
            Self::Deb => Command::new("dpkg-query")
                .args(["-W", "-f=${Version}", "factory-desktop"])
                .output()?,
            Self::Rpm => Command::new("rpm")
                .args(["-q", "--qf", "%{VERSION}", "factory-desktop"])
                .output()?,
        };
        if !output.status.success() {
            return Ok(None);
        }
        let version = String::from_utf8(output.stdout)?.trim().to_owned();
        Ok((!version.is_empty()).then_some(version))
    }

    fn install(&self, package: &Path) -> Result<(), Error> {
        let output = match self {
            Self::Deb => Command::new("dpkg").arg("-i").arg(package).output()?,
            Self::Rpm => Command::new("rpm")
                .args(["-Uvh", "--replacepkgs"])
                .arg(package)
                .output()?,
        };
        if !output.status.success() {
            return Err(format!(
                "{} update installation failed: {}",
                match self {
                    Self::Deb => "dpkg",
                    Self::Rpm => "rpm",
                },
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        Ok(())
    }
}
