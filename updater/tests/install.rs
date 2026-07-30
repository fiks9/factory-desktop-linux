use chrono::Utc;
use factory_update_manager::builder::{PackageFormat, ValidatedCandidate};
use factory_update_manager::install::{install_validated, InstallOutcome};
use factory_update_manager::package_manager::PackageManager;
use factory_update_manager::polkit::{read_unattended, Action};
use factory_update_manager::rollback::KnownGoodStore;
use serde_json::json;
use std::collections::VecDeque;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

struct FakeManager {
    format: PackageFormat,
    fail_first: bool,
    installs: Mutex<Vec<PathBuf>>,
    current_version: Mutex<Option<String>>,
    next_versions: Mutex<VecDeque<Option<String>>>,
}

impl PackageManager for FakeManager {
    fn format(&self) -> PackageFormat {
        self.format
    }

    fn installed_version(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.current_version.lock().unwrap().clone())
    }

    fn install(&self, package: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut installs = self.installs.lock().unwrap();
        installs.push(package.to_path_buf());
        if self.fail_first && installs.len() == 1 {
            Err("simulated install failure".into())
        } else {
            if let Some(next) = self.next_versions.lock().unwrap().pop_front() {
                *self.current_version.lock().unwrap() = next;
            }
            Ok(())
        }
    }
}

fn inspector(root: &Path) -> PathBuf {
    let scripts = root.join("scripts");
    fs::create_dir_all(&scripts).unwrap();
    fs::write(scripts.join("inspect-package.js"), "fixture").unwrap();
    let node = root.join("node");
    fs::write(&node, "#!/usr/bin/env bash\nprintf '{\"valid\":true}\n'\n").unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
    node
}

fn candidate(root: &Path, id: &str, version: &str) -> PathBuf {
    let package = root.join(format!("{id}.deb"));
    fs::write(&package, format!("package-{id}")).unwrap();
    let hash = factory_update_manager::cache::sha256_file(&package).unwrap();
    let manifest = root.join(format!("{id}.json"));
    let candidate = ValidatedCandidate {
        schema_version: 1,
        candidate_id: id.into(),
        version: version.into(),
        format: PackageFormat::Deb,
        package_bytes: fs::metadata(&package).unwrap().len(),
        package_path: package,
        package_sha256: hash,
        validated_at: Utc::now(),
        inspection: json!({"valid": true}),
        manifest_path: PathBuf::new(),
    };
    fs::write(&manifest, serde_json::to_vec_pretty(&candidate).unwrap()).unwrap();
    manifest
}

#[test]
fn successful_install_retains_root_owned_known_good() {
    let root = tempfile::tempdir().unwrap();
    let builder = root.path().join("builder");
    let node = inspector(&builder);
    let manifest = candidate(root.path(), "candidate-139", "0.139.0");
    let manager = FakeManager {
        format: PackageFormat::Deb,
        fail_first: false,
        installs: Mutex::new(vec![]),
        current_version: Mutex::new(Some("0.139.0".into())),
        next_versions: Mutex::new(VecDeque::from([Some("0.139.0".into())])),
    };
    let known_good = KnownGoodStore::new(root.path().join("known-good"), 2);

    let outcome = install_validated(
        &manifest,
        &builder,
        &node,
        root.path().join("root-cache").as_path(),
        &manager,
        &known_good,
    )
    .unwrap();

    assert_eq!(outcome, InstallOutcome::Installed);
    assert_eq!(known_good.list().unwrap().len(), 1);
}

#[test]
fn failed_install_attempts_one_known_good_rollback() {
    let root = tempfile::tempdir().unwrap();
    let builder = root.path().join("builder");
    let node = inspector(&builder);
    let known_good = KnownGoodStore::new(root.path().join("known-good"), 2);
    let previous_manifest = candidate(root.path(), "candidate-138", "0.138.0");
    let previous =
        factory_update_manager::builder::load_candidate_manifest(&previous_manifest).unwrap();
    known_good.retain(&previous).unwrap();
    let manifest = candidate(root.path(), "candidate-139", "0.139.0");
    let manager = FakeManager {
        format: PackageFormat::Deb,
        fail_first: true,
        installs: Mutex::new(vec![]),
        current_version: Mutex::new(Some("0.138.0".into())),
        next_versions: Mutex::new(VecDeque::from([Some("0.138.0".into())])),
    };

    let outcome = install_validated(
        &manifest,
        &builder,
        &node,
        root.path().join("root-cache").as_path(),
        &manager,
        &known_good,
    )
    .unwrap();

    assert_eq!(outcome, InstallOutcome::RolledBack);
    assert_eq!(manager.installs.lock().unwrap().len(), 2);
}

#[test]
fn rollback_requires_installed_version_to_match_known_good() {
    let root = tempfile::tempdir().unwrap();
    let builder = root.path().join("builder");
    let node = inspector(&builder);
    let known_good = KnownGoodStore::new(root.path().join("known-good"), 2);
    let previous_manifest = candidate(root.path(), "candidate-138", "0.138.0");
    let previous =
        factory_update_manager::builder::load_candidate_manifest(&previous_manifest).unwrap();
    known_good.retain(&previous).unwrap();
    let manifest = candidate(root.path(), "candidate-139", "0.139.0");
    let manager = FakeManager {
        format: PackageFormat::Deb,
        fail_first: true,
        installs: Mutex::new(vec![]),
        current_version: Mutex::new(Some("0.138.0".into())),
        next_versions: Mutex::new(VecDeque::from([Some("0.137.9".into())])),
    };

    let outcome = install_validated(
        &manifest,
        &builder,
        &node,
        root.path().join("root-cache").as_path(),
        &manager,
        &known_good,
    )
    .unwrap();

    assert_eq!(outcome, InstallOutcome::InstallFailedManualAction);
    assert_eq!(manager.installs.lock().unwrap().len(), 2);
}

#[test]
fn unattended_is_secure_by_default_and_never_changes_the_authenticated_install_action() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config.toml");
    assert!(!read_unattended(&config).unwrap());
    fs::write(&config, "unattended = false\n").unwrap();
    assert!(!read_unattended(&config).unwrap());
    fs::write(&config, "unattended = true\n").unwrap();
    assert!(read_unattended(&config).unwrap());

    assert_eq!(
        Action::for_install(PackageFormat::Deb, false).policy_id(),
        "org.factory.desktop.update-manager.install-deb"
    );
    assert_eq!(
        Action::for_install(PackageFormat::Rpm, false).policy_id(),
        "org.factory.desktop.update-manager.install-rpm"
    );
    assert_eq!(
        Action::for_install(PackageFormat::Deb, true).policy_id(),
        "org.factory.desktop.update-manager.install-deb"
    );
    assert_eq!(
        Action::InstallApprovedPackage.policy_id(),
        "org.factory.desktop.update-manager.install-approved-package"
    );
}

#[test]
fn forged_candidate_id_cannot_escape_known_good_storage() {
    let root = tempfile::tempdir().unwrap();
    let builder = root.path().join("builder");
    let node = inspector(&builder);
    let manifest = candidate(root.path(), "candidate-139", "0.139.0");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    value["candidate_id"] = json!("../../escape");
    fs::write(&manifest, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let manager = FakeManager {
        format: PackageFormat::Deb,
        fail_first: false,
        installs: Mutex::new(vec![]),
        current_version: Mutex::new(Some("0.139.0".into())),
        next_versions: Mutex::new(VecDeque::from([Some("0.139.0".into())])),
    };

    let error = install_validated(
        &manifest,
        &builder,
        &node,
        root.path().join("root-cache").as_path(),
        &manager,
        &KnownGoodStore::new(root.path().join("known-good"), 2),
    )
    .unwrap_err();

    assert!(error.to_string().contains("unsafe path"));
    assert!(manager.installs.lock().unwrap().is_empty());
}

#[test]
fn failed_index_publish_does_not_delete_previous_known_good_artifacts() {
    let root = tempfile::tempdir().unwrap();
    let known_good_root = root.path().join("known-good");
    let known_good = KnownGoodStore::new(known_good_root.clone(), 2);
    let first_manifest = candidate(root.path(), "candidate-137", "0.137.0");
    let second_manifest = candidate(root.path(), "candidate-138", "0.138.0");
    let third_manifest = candidate(root.path(), "candidate-139", "0.139.0");
    for manifest in [&first_manifest, &second_manifest] {
        let value = factory_update_manager::builder::load_candidate_manifest(manifest).unwrap();
        known_good.retain(&value).unwrap();
    }
    let previous = known_good.list().unwrap();
    assert_eq!(previous.len(), 2);
    let blocked_partial = known_good_root.join(format!(".index-{}.partial", std::process::id()));
    fs::create_dir(&blocked_partial).unwrap();

    let third = factory_update_manager::builder::load_candidate_manifest(&third_manifest).unwrap();
    assert!(known_good.retain(&third).is_err());

    for artifact in previous {
        assert!(
            artifact.package_path.is_file(),
            "published index must never point at a deleted package"
        );
    }
}
