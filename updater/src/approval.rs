use crate::builder::{PackageFormat, ValidatedCandidate};
use crate::cache::sha256_file;
use crate::package_manager::{Error, PackageManager};
use crate::state::sync_directory;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

const APPROVAL_SCHEMA_VERSION: u32 = 1;
const PACKAGE_NAME: &str = "factory-desktop";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRequest {
    pub schema_version: u32,
    pub package_name: String,
    pub version: String,
    pub format: PackageFormat,
    pub package_path: PathBuf,
    pub package_sha256: String,
    pub patch_report_sha256: String,
}

impl ApprovalRequest {
    pub fn from_candidate(candidate: &ValidatedCandidate) -> Result<Self, Error> {
        let object = candidate
            .inspection
            .as_object()
            .ok_or("candidate inspection is not an object")?;
        let required = |name: &str| -> Result<&str, Error> {
            object
                .get(name)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("candidate inspection {name} is missing").into())
        };
        let package_name = required("packageName")?;
        let version = required("version")?;
        let format = required("format")?;
        let package_sha256 = required("packageSha256")?;
        let patch_report_sha256 = required("patchReportSha256")?;
        if package_name != PACKAGE_NAME
            || version != candidate.version
            || format != candidate.format.extension()
            || package_sha256 != candidate.package_sha256
        {
            return Err("candidate inspection identity does not match validated candidate".into());
        }
        let request = Self {
            schema_version: APPROVAL_SCHEMA_VERSION,
            package_name: package_name.into(),
            version: version.into(),
            format: candidate.format,
            package_path: candidate.package_path.clone(),
            package_sha256: package_sha256.into(),
            patch_report_sha256: patch_report_sha256.into(),
        };
        validate_request(&request)?;
        Ok(request)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRecord {
    pub schema_version: u32,
    pub approval_id: String,
    pub package_name: String,
    pub version: String,
    pub format: PackageFormat,
    pub package_path: PathBuf,
    pub package_sha256: String,
    pub patch_report_sha256: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedPackage {
    pub package_name: String,
    pub version: String,
    pub format: PackageFormat,
    pub package_sha256: String,
    pub patch_report_sha256: String,
}

pub trait ApprovalInspector {
    fn inspect(&self, package: &Path) -> Result<InspectedPackage, Error>;
}

#[derive(Debug, Clone)]
pub struct NodeApprovalInspector {
    builder_root: PathBuf,
    node: PathBuf,
}

impl NodeApprovalInspector {
    pub fn new(builder_root: PathBuf, node: PathBuf) -> Self {
        Self { builder_root, node }
    }
}

impl ApprovalInspector for NodeApprovalInspector {
    fn inspect(&self, package: &Path) -> Result<InspectedPackage, Error> {
        let script = self.builder_root.join("scripts").join("inspect-package.js");
        if !script.is_file() {
            return Err(format!("approval inspector is missing: {}", script.display()).into());
        }
        let output = Command::new(&self.node)
            .arg(&script)
            .arg(package)
            .current_dir(&self.builder_root)
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "approval package inspection failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        let required = |name: &str| -> Result<String, Error> {
            value
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("approval inspection field {name} is missing").into())
        };
        let format = match required("format")?.as_str() {
            "deb" => PackageFormat::Deb,
            "rpm" => PackageFormat::Rpm,
            _ => return Err("approval inspection returned an unsupported format".into()),
        };
        let inspected = InspectedPackage {
            package_name: required("packageName")?,
            version: required("version")?,
            format,
            package_sha256: required("packageSha256")?,
            patch_report_sha256: required("patchReportSha256")?,
        };
        validate_digest(&inspected.package_sha256, "package")?;
        validate_digest(&inspected.patch_report_sha256, "patch report")?;
        Ok(inspected)
    }
}

pub fn write_approval_request(path: &Path, request: &ApprovalRequest) -> Result<(), Error> {
    validate_request(request)?;
    let parent = path.parent().ok_or("approval request path has no parent")?;
    fs::create_dir_all(parent)?;
    let partial = parent.join(format!(".approval-request-{}.partial", std::process::id()));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&partial)?;
    let result = (|| -> io::Result<()> {
        serde_json::to_writer_pretty(&mut output, request).map_err(io::Error::other)?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        fs::rename(&partial, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(())
}

pub fn load_approval_request(path: &Path) -> Result<ApprovalRequest, Error> {
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !input.metadata()?.file_type().is_file() {
        return Err("approval request must be a regular file".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut input)
        .take(1024 * 1024)
        .read_to_end(&mut bytes)?;
    let request: ApprovalRequest = serde_json::from_slice(&bytes)?;
    validate_request(&request)?;
    Ok(request)
}

#[derive(Debug, Clone)]
pub struct ApprovalStore {
    root: PathBuf,
    expected_uid: u32,
}

impl ApprovalStore {
    pub fn new(root: PathBuf, expected_uid: u32) -> Self {
        Self { root, expected_uid }
    }

    pub fn packages_dir(&self) -> PathBuf {
        self.root.join("packages")
    }

    pub fn approvals_dir(&self) -> PathBuf {
        self.root.join("approvals")
    }

    pub fn consumed_dir(&self) -> PathBuf {
        self.root.join("consumed")
    }

    pub fn approval_path(&self, id: &str) -> PathBuf {
        self.approvals_dir().join(format!("{id}.json"))
    }

    pub fn consumed_path(&self, id: &str) -> PathBuf {
        self.consumed_dir().join(format!("{id}.json"))
    }

    pub fn approve(
        &self,
        request: &ApprovalRequest,
        inspector: &dyn ApprovalInspector,
        now: DateTime<Utc>,
        ttl: Duration,
    ) -> Result<ApprovalRecord, Error> {
        self.ensure_layout()?;
        validate_request(request)?;
        if ttl <= Duration::zero() {
            return Err("approval expiry must be in the future".into());
        }
        let source_metadata = fs::symlink_metadata(&request.package_path)?;
        if !request.package_path.is_absolute() || !source_metadata.file_type().is_file() {
            return Err("approval source must be an absolute regular file without symlinks".into());
        }
        let source_inspection = inspector.inspect(&request.package_path)?;
        validate_inspection(request, &source_inspection)?;

        let package_path = self.packages_dir().join(format!(
            "Factory-{}.{}",
            request.package_sha256,
            request.format.extension()
        ));
        if package_path.exists() {
            verify_secure_file(&package_path, self.expected_uid, 0o600)?;
            if sha256_file(&package_path)? != request.package_sha256 {
                return Err("root package cache collision".into());
            }
        } else {
            copy_no_follow(&request.package_path, &package_path)?;
            fs::set_permissions(&package_path, fs::Permissions::from_mode(0o600))?;
            sync_directory(&self.packages_dir())?;
        }
        verify_secure_file(&package_path, self.expected_uid, 0o600)?;
        if sha256_file(&package_path)? != request.package_sha256 {
            return Err("root package hash does not match approval request".into());
        }
        validate_inspection(request, &inspector.inspect(&package_path)?)?;

        let approval_id = random_approval_id()?;
        let record = ApprovalRecord {
            schema_version: APPROVAL_SCHEMA_VERSION,
            approval_id: approval_id.clone(),
            package_name: request.package_name.clone(),
            version: request.version.clone(),
            format: request.format,
            package_path: fs::canonicalize(package_path)?,
            package_sha256: request.package_sha256.clone(),
            patch_report_sha256: request.patch_report_sha256.clone(),
            created_at: now,
            expires_at: now + ttl,
        };
        write_record(&self.approval_path(&approval_id), &record)?;
        verify_secure_file(&self.approval_path(&approval_id), self.expected_uid, 0o600)?;
        sync_directory(&self.approvals_dir())?;
        Ok(record)
    }

    pub fn install_approved(
        &self,
        approval_id: &str,
        inspector: &dyn ApprovalInspector,
        manager: &dyn PackageManager,
        now: DateTime<Utc>,
    ) -> Result<ApprovalRecord, Error> {
        validate_approval_id(approval_id)?;
        self.verify_layout()?;
        let active = self.approval_path(approval_id);
        verify_secure_file(&active, self.expected_uid, 0o600)?;
        let record: ApprovalRecord = serde_json::from_slice(&fs::read(&active)?)?;
        self.validate_record(&record, approval_id, inspector, manager, now)?;

        let consumed = self.consumed_path(approval_id);
        if consumed.exists() {
            return Err("approval has already been consumed".into());
        }
        fs::rename(&active, &consumed)?;
        sync_directory(&self.approvals_dir())?;
        sync_directory(&self.consumed_dir())?;

        manager.install(&record.package_path)?;
        match manager.installed_version()? {
            Some(version) if version == record.version => Ok(record),
            Some(version) => Err(format!(
                "approved install verification failed: expected {}, got {version}",
                record.version
            )
            .into()),
            None => Err("approved install verification failed: package is absent".into()),
        }
    }

    fn ensure_layout(&self) -> Result<(), Error> {
        for directory in [
            self.root.clone(),
            self.packages_dir(),
            self.approvals_dir(),
            self.consumed_dir(),
        ] {
            fs::create_dir_all(&directory)?;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
            verify_secure_directory(&directory, self.expected_uid)?;
        }
        Ok(())
    }

    fn verify_layout(&self) -> Result<(), Error> {
        for directory in [
            &self.root,
            &self.packages_dir(),
            &self.approvals_dir(),
            &self.consumed_dir(),
        ] {
            verify_secure_directory(directory, self.expected_uid)?;
        }
        Ok(())
    }

    fn validate_record(
        &self,
        record: &ApprovalRecord,
        approval_id: &str,
        inspector: &dyn ApprovalInspector,
        manager: &dyn PackageManager,
        now: DateTime<Utc>,
    ) -> Result<(), Error> {
        if record.schema_version != APPROVAL_SCHEMA_VERSION
            || record.approval_id != approval_id
            || record.package_name != PACKAGE_NAME
            || record.expires_at <= now
            || record.created_at > now
        {
            return Err("approval record identity or expiry is invalid".into());
        }
        validate_digest(&record.package_sha256, "package")?;
        validate_digest(&record.patch_report_sha256, "patch report")?;
        if record.format != manager.format() {
            return Err("approval format does not match package manager".into());
        }
        let canonical_packages = fs::canonicalize(self.packages_dir())?;
        let canonical_package = fs::canonicalize(&record.package_path)?;
        if canonical_package != record.package_path
            || !canonical_package.starts_with(&canonical_packages)
        {
            return Err("approval package escaped the root cache".into());
        }
        verify_secure_file(&canonical_package, self.expected_uid, 0o600)?;
        if sha256_file(&canonical_package)? != record.package_sha256 {
            return Err("approved package hash changed".into());
        }
        let inspection = inspector.inspect(&canonical_package)?;
        if inspection.package_name != record.package_name
            || inspection.version != record.version
            || inspection.format != record.format
            || inspection.package_sha256 != record.package_sha256
            || inspection.patch_report_sha256 != record.patch_report_sha256
        {
            return Err("approved package inspection no longer matches the record".into());
        }
        let installed = manager
            .installed_version()?
            .ok_or("Factory Desktop is not installed")?;
        if !is_strict_upgrade(&installed, &record.version)? {
            return Err("approved package version is not newer than installed version".into());
        }
        Ok(())
    }
}

fn validate_request(request: &ApprovalRequest) -> Result<(), Error> {
    if request.schema_version != APPROVAL_SCHEMA_VERSION || request.package_name != PACKAGE_NAME {
        return Err("approval request identity is invalid".into());
    }
    crate::upstream::parse_version(&request.version)?;
    validate_digest(&request.package_sha256, "package")?;
    validate_digest(&request.patch_report_sha256, "patch report")?;
    if request
        .package_path
        .extension()
        .and_then(|value| value.to_str())
        != Some(request.format.extension())
    {
        return Err("approval request package extension does not match format".into());
    }
    Ok(())
}

fn validate_inspection(
    request: &ApprovalRequest,
    inspection: &InspectedPackage,
) -> Result<(), Error> {
    if inspection.package_name != request.package_name
        || inspection.version != request.version
        || inspection.format != request.format
        || inspection.package_sha256 != request.package_sha256
        || inspection.patch_report_sha256 != request.patch_report_sha256
    {
        return Err("package inspection does not match approval request".into());
    }
    Ok(())
}

fn validate_digest(value: &str, label: &str) -> Result<(), Error> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} SHA-256 is invalid").into());
    }
    Ok(())
}

fn validate_approval_id(value: &str) -> Result<(), Error> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("approval ID must be exactly 64 lowercase hex characters".into());
    }
    Ok(())
}

fn verify_secure_directory(path: &Path, expected_uid: u32) -> Result<(), Error> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != expected_uid
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(format!("insecure approval directory: {}", path.display()).into());
    }
    Ok(())
}

fn verify_secure_file(path: &Path, expected_uid: u32, mode: u32) -> Result<(), Error> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != expected_uid
        || metadata.permissions().mode() & 0o777 != mode
    {
        return Err(format!("insecure approval file: {}", path.display()).into());
    }
    Ok(())
}

fn copy_no_follow(source: &Path, target: &Path) -> io::Result<()> {
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(source)?;
    let partial = target.with_extension(format!(
        "{}.{}.partial",
        target
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("pkg"),
        std::process::id()
    ));
    let result = (|| {
        let mut destination = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&partial)?;
        io::copy(&mut source, &mut destination)?;
        destination.sync_all()?;
        fs::rename(&partial, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(partial);
    }
    result
}

fn write_record(path: &Path, record: &ApprovalRecord) -> io::Result<()> {
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    serde_json::to_writer_pretty(&mut output, record).map_err(io::Error::other)?;
    output.write_all(b"\n")?;
    output.sync_all()
}

fn random_approval_id() -> Result<String, Error> {
    let mut entropy = [0_u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut entropy)?;
    let digest = Sha256::digest(entropy);
    let mut result = String::with_capacity(64);
    for byte in digest {
        write!(&mut result, "{byte:02x}")?;
    }
    Ok(result)
}

fn is_strict_upgrade(installed: &str, candidate: &str) -> Result<bool, Error> {
    fn components(version: &str) -> Result<[u64; 3], Error> {
        crate::upstream::parse_version(version)?;
        let values: Vec<u64> = version
            .split('.')
            .map(str::parse)
            .collect::<Result<_, _>>()?;
        Ok([values[0], values[1], values[2]])
    }
    Ok(components(candidate)? > components(installed)?)
}
