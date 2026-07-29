use crate::builder::{load_candidate_manifest, ValidatedCandidate};
use crate::cache::sha256_file;
use crate::package_manager::PackageManager;
use crate::rollback::KnownGoodStore;
use crate::state::sync_directory;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed,
    RolledBack,
    InstallFailedManualAction,
}

pub fn install_validated(
    manifest: &Path,
    builder_root: &Path,
    node: &Path,
    root_cache: &Path,
    manager: &dyn PackageManager,
    known_good: &KnownGoodStore,
) -> Result<InstallOutcome, Error> {
    let mut candidate = load_candidate_manifest(manifest)?;
    if candidate.format != manager.format() {
        return Err("candidate package format does not match installed package manager".into());
    }
    validate_candidate(&candidate)?;
    candidate.package_path = copy_to_root_cache(&candidate, root_cache)?;
    validate_candidate(&candidate)?;
    inspect_package(builder_root, node, &candidate.package_path)?;

    match manager
        .install(&candidate.package_path)
        .and_then(|_| verify_installed_version(manager, &candidate.version, "update"))
    {
        Ok(()) => {
            known_good.retain(&candidate)?;
            Ok(InstallOutcome::Installed)
        }
        Err(_) => rollback_once(manager, known_good),
    }
}

fn validate_candidate(candidate: &ValidatedCandidate) -> Result<(), Error> {
    crate::upstream::parse_version(&candidate.version)?;
    if candidate.candidate_id.is_empty()
        || !candidate
            .candidate_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("candidate id contains unsafe path characters".into());
    }
    if candidate.package_sha256.len() != 64
        || !candidate
            .package_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("candidate package digest is invalid".into());
    }
    if !candidate.package_path.is_absolute() {
        return Err("candidate package path must be absolute".into());
    }
    let metadata = fs::symlink_metadata(&candidate.package_path)?;
    if !metadata.file_type().is_file() || metadata.len() != candidate.package_bytes {
        return Err("candidate package metadata changed after validation".into());
    }
    if candidate
        .package_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some(candidate.format.extension())
    {
        return Err("candidate package extension does not match manifest".into());
    }
    if sha256_file(&candidate.package_path)? != candidate.package_sha256 {
        return Err("candidate package hash changed after validation".into());
    }
    Ok(())
}

fn copy_to_root_cache(candidate: &ValidatedCandidate, root: &Path) -> Result<PathBuf, Error> {
    fs::create_dir_all(root)?;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    remove_partial_files(root)?;
    let target = root.join(format!(
        "Factory-{}.{}",
        candidate.package_sha256,
        candidate.format.extension()
    ));
    if target.exists() {
        if sha256_file(&target)? != candidate.package_sha256 {
            return Err("root package cache collision".into());
        }
        return Ok(fs::canonicalize(target)?);
    }
    let partial = root.join(format!(
        ".Factory-{}-{}.partial",
        std::process::id(),
        candidate.format.extension()
    ));
    let result = (|| -> io::Result<()> {
        let mut source = fs::File::open(&candidate.package_path)?;
        let mut destination = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&partial)?;
        io::copy(&mut source, &mut destination)?;
        destination.sync_all()?;
        fs::rename(&partial, &target)?;
        sync_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(fs::canonicalize(target)?)
}

fn remove_partial_files(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.file_name().to_string_lossy().ends_with(".partial")
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn inspect_package(builder_root: &Path, node: &Path, package: &Path) -> Result<(), Error> {
    let script = builder_root.join("scripts").join("inspect-package.js");
    if !script.is_file() {
        return Err(format!(
            "installed update-builder inspector is missing: {}",
            script.display()
        )
        .into());
    }
    let output = Command::new(node)
        .arg(script)
        .arg(package)
        .current_dir(builder_root)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "privileged package inspection failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    if !result.is_object() {
        return Err("privileged package inspector did not return an object".into());
    }
    Ok(())
}

fn verify_installed_version(
    manager: &dyn PackageManager,
    expected_version: &str,
    context: &str,
) -> Result<(), Error> {
    match manager.installed_version()? {
        Some(version) if version == expected_version => Ok(()),
        Some(version) => Err(format!(
            "installed version mismatch after {context}: expected {expected_version}, got {version}"
        )
        .into()),
        None => Err(format!("package manager cannot find Factory Desktop after {context}").into()),
    }
}

fn rollback_once(
    manager: &dyn PackageManager,
    known_good: &KnownGoodStore,
) -> Result<InstallOutcome, Error> {
    let Some(previous) = known_good.latest()? else {
        return Ok(InstallOutcome::InstallFailedManualAction);
    };
    if previous.format != manager.format() {
        return Ok(InstallOutcome::InstallFailedManualAction);
    }
    match manager.install(&previous.package_path) {
        Ok(()) => match verify_installed_version(manager, &previous.version, "rollback") {
            Ok(()) => Ok(InstallOutcome::RolledBack),
            Err(_) => Ok(InstallOutcome::InstallFailedManualAction),
        },
        Err(_) => Ok(InstallOutcome::InstallFailedManualAction),
    }
}
