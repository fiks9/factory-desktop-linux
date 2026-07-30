use chrono::Utc;
use factory_update_manager::builder::{PackageFormat, ValidatedCandidate};
use factory_update_manager::cache::sha256_file;
use factory_update_manager::cleanup::cleanup;
use factory_update_manager::paths::Paths;
use factory_update_manager::state::{State, StateRecord, StateStore};
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn test_paths(root: &Path) -> Paths {
    Paths {
        state_dir: root.join("state-home").join("factory-update-manager"),
        cache_dir: root.join("cache-home").join("factory-update-manager"),
        config_dir: root.join("config-home").join("factory-update-manager"),
    }
}

fn command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_factory-update-manager"));
    command
        .env("HOME", root.join("home"))
        .env("XDG_STATE_HOME", root.join("state-home"))
        .env("XDG_CACHE_HOME", root.join("cache-home"))
        .env("XDG_CONFIG_HOME", root.join("config-home"));
    command
}

fn candidate(paths: &Paths, id: &str, version: &str) -> (PathBuf, PathBuf) {
    let workspace = paths.workspaces_dir().join(id);
    fs::create_dir_all(&workspace).unwrap();
    let package = workspace.join(format!("{id}.deb"));
    fs::write(&package, format!("package-{id}")).unwrap();
    let manifest = workspace.join("validated-candidate.json");
    let value = ValidatedCandidate {
        schema_version: 1,
        candidate_id: id.into(),
        version: version.into(),
        format: PackageFormat::Deb,
        package_path: package.clone(),
        package_sha256: sha256_file(&package).unwrap(),
        package_bytes: fs::metadata(&package).unwrap().len(),
        validated_at: Utc::now(),
        inspection: json!({"valid": true}),
        manifest_path: PathBuf::new(),
    };
    fs::write(&manifest, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    (manifest, package)
}

#[test]
fn rejected_candidate_is_recorded_as_failed() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let dmg = root.path().join("fixture.dmg");
    fs::create_dir(&home).unwrap();
    fs::write(&dmg, "not a real DMG").unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_factory-update-manager"))
        .env("HOME", &home)
        .arg("--builder-root")
        .arg(root.path().join("missing-builder"))
        .arg("check-now")
        .arg("--dmg")
        .arg(&dmg)
        .arg("--version")
        .arg("0.139.0")
        .arg("--format")
        .arg("deb")
        .status()
        .unwrap();

    assert!(!status.success());
    let state_path = home.join(".local/state/factory-update-manager/state.json");
    let state: StateRecord = serde_json::from_slice(&fs::read(state_path).unwrap()).unwrap();
    assert_eq!(state.state, State::Failed);
    assert!(state.message.unwrap().contains("candidate rejected"));
}

#[test]
fn status_json_has_a_stable_top_level_schema_version() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();

    let output = command(root.path())
        .args(["status", "--json"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["kind"], "idle");
    assert_eq!(value["linuxState"], "idle");
    assert_eq!(value["state"]["state"], "idle");
    assert!(value["stateFile"].as_str().unwrap().ends_with("state.json"));
}

#[test]
fn status_json_exposes_manual_command_and_sanitized_fields_separately() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    StateStore::new(paths.state_file())
        .save(&StateRecord {
            state: State::InstallFailedManualAction,
            version: Some("0.139.0".into()),
            package_path: Some(PathBuf::from("/safe/candidate.deb")),
            package_sha256: Some("a".repeat(64)),
            manual_command: Some("sudo factory-update-manager reconcile-install\n".into()),
            message: Some("Manual action required\u{0000}<b>not html</b>".into()),
            ..StateRecord::default()
        })
        .unwrap();

    let output = command(root.path())
        .args(["status", "--json"])
        .output()
        .unwrap();

    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["kind"], "error");
    assert_eq!(value["linuxState"], "install-failed-manual-action");
    assert_eq!(
        value["manualCommand"],
        "sudo factory-update-manager reconcile-install"
    );
    assert_eq!(value["version"], "0.139.0");
    assert_eq!(value["packagePath"], "/safe/candidate.deb");
    assert_eq!(value["packageSha256"], "a".repeat(64));
    assert!(!value["message"].as_str().unwrap().contains('\0'));
}

#[test]
fn daemon_once_recovers_installing_and_preserves_candidate() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let (manifest, package) = candidate(&paths, "candidate-139", "0.139.0");
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::Installing,
            candidate_id: Some("candidate-139".into()),
            version: Some("0.139.0".into()),
            package_path: Some(package.clone()),
            package_sha256: Some(sha256_file(&package).unwrap()),
            candidate_manifest: Some(manifest.clone()),
            ..StateRecord::default()
        })
        .unwrap();

    let status = command(root.path())
        .args(["daemon", "--once"])
        .status()
        .unwrap();

    assert!(status.success());
    let state = store.load().unwrap();
    assert_eq!(state.state, State::InstallFailedManualAction);
    assert!(manifest.is_file());
    assert!(package.is_file());
}

#[test]
fn polkit_failure_retains_manual_action_candidate_through_cleanup() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let (manifest, package) = candidate(&paths, "candidate-139", "0.139.0");
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::ReadyPendingExit,
            candidate_id: Some("candidate-139".into()),
            version: Some("0.139.0".into()),
            package_path: Some(package.clone()),
            package_sha256: Some(sha256_file(&package).unwrap()),
            candidate_manifest: Some(manifest.clone()),
            ..StateRecord::default()
        })
        .unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let pkexec = bin.join("pkexec");
    fs::write(&pkexec, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&pkexec, fs::Permissions::from_mode(0o755)).unwrap();

    let status = command(root.path())
        .env("PATH", &bin)
        .arg("install-ready")
        .status()
        .unwrap();

    assert!(status.success());
    let state = store.load().unwrap();
    assert_eq!(state.state, State::InstallFailedManualAction);
    cleanup(&paths, &state).unwrap();
    assert!(manifest.is_file());
    assert!(package.is_file());
}

#[test]
fn prepare_install_marks_one_request_and_rejects_a_duplicate() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let (manifest, package) = candidate(&paths, "candidate-140", "0.140.0");
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::ReadyPendingExit,
            candidate_id: Some("candidate-140".into()),
            version: Some("0.140.0".into()),
            package_path: Some(package),
            package_sha256: Some("a".repeat(64)),
            candidate_manifest: Some(manifest),
            ..StateRecord::default()
        })
        .unwrap();

    let first = command(root.path())
        .args(["prepare-install", "--pid", "4242", "--no-spawn"])
        .output()
        .unwrap();
    assert!(first.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(envelope["installRequested"], true);
    assert!(store.load().unwrap().install_requested);

    let second = command(root.path())
        .args(["prepare-install", "--pid", "4242", "--no-spawn"])
        .status()
        .unwrap();
    assert!(!second.success());
    assert_eq!(store.load().unwrap().state, State::ReadyPendingExit);
}

#[test]
fn reconcile_install_requires_the_expected_installed_version() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::InstallFailedManualAction,
            version: Some("0.140.0".into()),
            manual_command: Some("sudo dpkg -i /safe/candidate.deb".into()),
            ..StateRecord::default()
        })
        .unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let query = bin.join("dpkg-query");
    fs::write(&query, "#!/bin/sh\nprintf '0.140.0'\n").unwrap();
    fs::set_permissions(&query, fs::Permissions::from_mode(0o755)).unwrap();

    let status = command(root.path())
        .env("PATH", &bin)
        .arg("reconcile-install")
        .status()
        .unwrap();

    assert!(status.success());
    let state = store.load().unwrap();
    assert_eq!(state.state, State::Installed);
    assert_eq!(state.manual_command, None);
}

#[test]
fn setup_unattended_requires_explicit_security_acknowledgement() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();

    let refused = command(root.path())
        .arg("setup-unattended")
        .status()
        .unwrap();
    assert!(!refused.success());

    let accepted = command(root.path())
        .args(["setup-unattended", "--acknowledge-authentication-required"])
        .status()
        .unwrap();
    assert!(accepted.success());
    let config = root
        .path()
        .join("config-home/factory-update-manager/config.toml");
    assert!(factory_update_manager::polkit::read_unattended(&config).unwrap());
    assert_eq!(
        fs::metadata(config).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
