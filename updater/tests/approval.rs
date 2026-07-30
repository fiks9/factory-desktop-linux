use chrono::{Duration, TimeZone, Utc};
use factory_update_manager::approval::{
    write_approval_request, ApprovalInspector, ApprovalRequest, ApprovalStore, InspectedPackage,
};
use factory_update_manager::builder::{PackageFormat, ValidatedCandidate};
use factory_update_manager::cache::sha256_file;
use factory_update_manager::package_manager::{Error, PackageManager};
use std::cell::{Cell, RefCell};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;

struct FakeInspector {
    version: RefCell<String>,
    patch_hash: RefCell<String>,
}

impl FakeInspector {
    fn valid() -> Self {
        Self {
            version: RefCell::new("0.140.0".into()),
            patch_hash: RefCell::new("b".repeat(64)),
        }
    }
}

impl ApprovalInspector for FakeInspector {
    fn inspect(&self, package: &Path) -> Result<InspectedPackage, Error> {
        Ok(InspectedPackage {
            package_name: "factory-desktop".into(),
            version: self.version.borrow().clone(),
            format: PackageFormat::Deb,
            package_sha256: sha256_file(package)?,
            patch_report_sha256: self.patch_hash.borrow().clone(),
        })
    }
}

struct FakeManager {
    version: RefCell<Option<String>>,
    installs: Cell<usize>,
    fail: Cell<bool>,
}

impl FakeManager {
    fn new(version: &str) -> Self {
        Self {
            version: RefCell::new(Some(version.into())),
            installs: Cell::new(0),
            fail: Cell::new(false),
        }
    }
}

impl PackageManager for FakeManager {
    fn format(&self) -> PackageFormat {
        PackageFormat::Deb
    }

    fn installed_version(&self) -> Result<Option<String>, Error> {
        Ok(self.version.borrow().clone())
    }

    fn install(&self, _package: &Path) -> Result<(), Error> {
        self.installs.set(self.installs.get() + 1);
        if self.fail.get() {
            return Err("fake install failed".into());
        }
        *self.version.borrow_mut() = Some("0.140.0".into());
        Ok(())
    }
}

fn fixture() -> (
    tempfile::TempDir,
    ApprovalStore,
    ApprovalRequest,
    FakeInspector,
) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("candidate.deb");
    fs::write(&source, b"validated package").unwrap();
    let inspector = FakeInspector::valid();
    let request = ApprovalRequest {
        schema_version: 1,
        package_name: "factory-desktop".into(),
        version: "0.140.0".into(),
        format: PackageFormat::Deb,
        package_path: source,
        package_sha256: sha256_file(&root.path().join("candidate.deb")).unwrap(),
        patch_report_sha256: "b".repeat(64),
    };
    let store = ApprovalStore::new(root.path().join("root-cache"), unsafe { libc::geteuid() });
    (root, store, request, inspector)
}

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 7, 30, 12, 0, 0)
        .single()
        .unwrap()
}

#[test]
fn approval_request_is_bound_to_candidate_inspection_and_written_mode_0600() {
    let root = tempfile::tempdir().unwrap();
    let package = root.path().join("candidate.deb");
    fs::write(&package, b"candidate").unwrap();
    let package_hash = sha256_file(&package).unwrap();
    let candidate = ValidatedCandidate {
        schema_version: 1,
        candidate_id: "candidate-140".into(),
        version: "0.140.0".into(),
        format: PackageFormat::Deb,
        package_path: package.clone(),
        package_sha256: package_hash.clone(),
        package_bytes: fs::metadata(&package).unwrap().len(),
        validated_at: now(),
        inspection: serde_json::json!({
            "packageName": "factory-desktop",
            "version": "0.140.0",
            "format": "deb",
            "packageSha256": package_hash,
            "patchReportSha256": "b".repeat(64),
        }),
        manifest_path: PathBuf::new(),
    };
    let request = ApprovalRequest::from_candidate(&candidate).unwrap();
    let request_path = root.path().join("approval-request.json");
    write_approval_request(&request_path, &request).unwrap();

    assert_eq!(request.package_name, "factory-desktop");
    assert_eq!(request.patch_report_sha256, "b".repeat(64));
    assert_eq!(
        fs::metadata(&request_path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let mut drifted = candidate;
    drifted.inspection["version"] = serde_json::json!("0.141.0");
    assert!(ApprovalRequest::from_candidate(&drifted).is_err());
}

#[test]
fn root_approval_stages_confined_package_and_installs_once() {
    let (_root, store, request, inspector) = fixture();
    let approval = store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .unwrap();
    assert_eq!(approval.schema_version, 1);
    assert_eq!(approval.package_name, "factory-desktop");
    assert_eq!(approval.package_sha256, request.package_sha256);
    assert_eq!(approval.patch_report_sha256, request.patch_report_sha256);
    assert!(approval.package_path.starts_with(store.packages_dir()));
    assert_eq!(
        fs::metadata(store.approval_path(&approval.approval_id))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let manager = FakeManager::new("0.139.0");
    store
        .install_approved(&approval.approval_id, &inspector, &manager, now())
        .unwrap();
    assert_eq!(manager.installs.get(), 1);
    assert!(!store.approval_path(&approval.approval_id).exists());
    assert!(store.consumed_path(&approval.approval_id).exists());
    assert!(store
        .install_approved(&approval.approval_id, &inspector, &manager, now())
        .is_err());
    assert_eq!(manager.installs.get(), 1);
}

#[test]
fn approval_rejects_traversal_symlink_and_unsafe_permissions() {
    let (_root, store, request, inspector) = fixture();
    assert!(store
        .install_approved(
            "../../candidate",
            &inspector,
            &FakeManager::new("0.139.0"),
            now()
        )
        .is_err());
    let approval = store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .unwrap();
    fs::set_permissions(
        store.approval_path(&approval.approval_id),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(store
        .install_approved(
            &approval.approval_id,
            &inspector,
            &FakeManager::new("0.139.0"),
            now()
        )
        .is_err());
    fs::remove_file(store.approval_path(&approval.approval_id)).unwrap();
    std::os::unix::fs::symlink(
        store.consumed_dir(),
        store.approval_path(&approval.approval_id),
    )
    .unwrap();
    assert!(store
        .install_approved(
            &approval.approval_id,
            &inspector,
            &FakeManager::new("0.139.0"),
            now()
        )
        .is_err());
}

#[test]
fn approval_rejects_expiry_hash_patch_report_and_metadata_drift() {
    let (_root, store, request, inspector) = fixture();
    let expired = store
        .approve(&request, &inspector, now(), Duration::minutes(1))
        .unwrap();
    assert!(store
        .install_approved(
            &expired.approval_id,
            &inspector,
            &FakeManager::new("0.139.0"),
            now() + Duration::minutes(2)
        )
        .is_err());

    let (_root, store, request, inspector) = fixture();
    let approval = store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .unwrap();
    fs::write(&approval.package_path, b"tampered").unwrap();
    assert!(store
        .install_approved(
            &approval.approval_id,
            &inspector,
            &FakeManager::new("0.139.0"),
            now()
        )
        .is_err());

    let (_root, store, request, inspector) = fixture();
    let approval = store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .unwrap();
    *inspector.patch_hash.borrow_mut() = "c".repeat(64);
    assert!(store
        .install_approved(
            &approval.approval_id,
            &inspector,
            &FakeManager::new("0.139.0"),
            now()
        )
        .is_err());
}

#[test]
fn approval_rejects_non_upgrade_and_consumes_before_failed_install() {
    let (_root, store, request, inspector) = fixture();
    let same = store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .unwrap();
    assert!(store
        .install_approved(
            &same.approval_id,
            &inspector,
            &FakeManager::new("0.140.0"),
            now()
        )
        .is_err());

    let approval = store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .unwrap();
    let manager = FakeManager::new("0.139.0");
    manager.fail.set(true);
    assert!(store
        .install_approved(&approval.approval_id, &inspector, &manager, now())
        .is_err());
    assert_eq!(manager.installs.get(), 1);
    assert!(!store.approval_path(&approval.approval_id).exists());
    assert!(store.consumed_path(&approval.approval_id).exists());
}

#[test]
fn approval_request_rejects_symlink_source_and_metadata_mismatch() {
    let (root, store, mut request, inspector) = fixture();
    let link = root.path().join("candidate-link.deb");
    std::os::unix::fs::symlink(&request.package_path, &link).unwrap();
    request.package_path = link;
    assert!(store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .is_err());

    request.package_path = root.path().join("candidate.deb");
    request.version = "0.141.0".into();
    assert!(store
        .approve(&request, &inspector, now(), Duration::minutes(30))
        .is_err());
}
