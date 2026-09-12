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
    let proc_root = root.join("proc");
    fs::create_dir_all(&proc_root).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_factory-update-manager"));
    command
        .env("HOME", root.join("home"))
        .env("XDG_STATE_HOME", root.join("state-home"))
        .env("XDG_CACHE_HOME", root.join("cache-home"))
        .env("XDG_CONFIG_HOME", root.join("config-home"))
        .env("FACTORY_TEST_PROC_ROOT", proc_root);
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

fn ready_candidate(paths: &Paths) -> StateRecord {
    let (manifest, package) = candidate(paths, "candidate-140", "0.140.0");
    StateRecord {
        state: State::ReadyToInstall,
        candidate_id: Some("candidate-140".into()),
        version: Some("0.140.0".into()),
        package_sha256: Some(sha256_file(&package).unwrap()),
        package_path: Some(package),
        candidate_manifest: Some(manifest),
        ..StateRecord::default()
    }
}

#[test]
fn metadata_check_records_available_update_without_building_candidate() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let bin = root.path().join("bin");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&bin).unwrap();
    let query = bin.join("dpkg-query");
    fs::write(&query, "#!/bin/sh\nprintf '0.139.0-1'\n").unwrap();
    fs::set_permissions(&query, fs::Permissions::from_mode(0o755)).unwrap();
    let output = command(root.path())
        .env("PATH", &bin)
        .args(["check-now", "--version", "0.140.0", "--format", "deb"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = StateStore::new(test_paths(root.path()).state_file())
        .load()
        .unwrap();
    assert_eq!(state.state, State::UpdateAvailable);
    assert_eq!(state.available_version.as_deref(), Some("0.140.0"));
    assert!(state.candidate_manifest.is_none());
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
            state: State::ReadyToInstall,
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
        .arg("update")
        .arg("--pid")
        .arg("4242")
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
fn cancelled_polkit_authentication_keeps_validated_candidate_ready_to_retry() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let (manifest, package) = candidate(&paths, "candidate-140", "0.140.0");
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::ReadyToInstall,
            candidate_id: Some("candidate-140".into()),
            version: Some("0.140.0".into()),
            package_path: Some(package.clone()),
            package_sha256: Some(sha256_file(&package).unwrap()),
            candidate_manifest: Some(manifest.clone()),
            ..StateRecord::default()
        })
        .unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let pkexec = bin.join("pkexec");
    fs::write(&pkexec, "#!/bin/sh\nexit 126\n").unwrap();
    fs::set_permissions(&pkexec, fs::Permissions::from_mode(0o755)).unwrap();

    let output = command(root.path())
        .env("PATH", &bin)
        .args(["update", "--pid", "4242"])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = store.load().unwrap();
    assert_eq!(state.state, State::ReadyToInstall);
    assert!(!state.install_requested);
    assert_eq!(state.manual_command, None);
    assert!(manifest.is_file());
    assert!(package.is_file());
}

#[test]
fn exit_timeout_retains_candidate_across_checks_restart_and_retry() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let original = ready_candidate(&paths);
    let manifest = original.candidate_manifest.as_ref().unwrap();
    let package = original.package_path.as_ref().unwrap();
    let store = StateStore::new(paths.state_file());
    store.save(&original).unwrap();
    let parent = root.path().join("proc/4242");
    fs::create_dir_all(&parent).unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();

    let output = command(root.path())
        .env("PATH", &bin)
        .env("FACTORY_TEST_EXIT_TIMEOUT_MS", "0")
        .args(["update", "--pid", "4242"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("timed out"));
    let timed_out = store.load().unwrap();
    assert_eq!(timed_out.state, State::ReadyToInstall);
    assert!(!timed_out.install_requested);

    for arguments in [
        vec!["check-now", "--version", "0.141.0", "--format", "deb"],
        vec!["daemon", "--once"],
        vec!["status", "--json"],
    ] {
        let output = command(root.path())
            .env("PATH", &bin)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(store.load().unwrap(), timed_out);
        assert!(manifest.is_file());
        assert_eq!(
            sha256_file(package).unwrap(),
            original.package_sha256.as_ref().unwrap().as_str()
        );
    }

    fs::remove_dir(parent).unwrap();
    let pkexec = bin.join("pkexec");
    let invocation = root.path().join("install-arguments");
    fs::write(
        &pkexec,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FACTORY_TEST_INSTALL_ARGUMENTS\"\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&pkexec, fs::Permissions::from_mode(0o755)).unwrap();
    let output = command(root.path())
        .env("PATH", &bin)
        .env("FACTORY_TEST_INSTALL_ARGUMENTS", &invocation)
        .arg("--builder-root")
        .arg(root.path().join("no-builder"))
        .arg("--node")
        .arg(root.path().join("no-node"))
        .args(["update", "--pid", "4242"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let arguments = fs::read_to_string(invocation).unwrap();
    assert!(arguments.lines().any(|argument| argument == "install-deb"));
    assert!(arguments
        .lines()
        .any(|argument| Path::new(argument) == manifest));
    let retried = store.load().unwrap();
    assert_eq!(retried.state, State::InstallFailedManualAction);
    assert!(!retried.install_requested);
    assert_eq!(retried.candidate_id, original.candidate_id);
    assert_eq!(retried.version, original.version);
    assert_eq!(retried.package_path, original.package_path);
    assert_eq!(retried.package_sha256, original.package_sha256);
    assert_eq!(retried.candidate_manifest, original.candidate_manifest);
    assert!(manifest.is_file());
    assert!(package.is_file());
}

#[test]
fn legacy_exit_timeout_is_recovered_before_status_checks_and_startup_cleanup() {
    for arguments in [
        vec!["status", "--json"],
        vec!["check-now", "--version", "0.141.0", "--format", "deb"],
        vec!["daemon", "--once"],
    ] {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        let paths = test_paths(root.path());
        paths.ensure_all().unwrap();
        let mut original = ready_candidate(&paths);
        original.state = State::Failed;
        original.message = Some("timed out waiting for Factory Desktop to exit".into());
        original.install_requested = true;
        let store = StateStore::new(paths.state_file());
        store.save(&original).unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();

        let output = command(root.path())
            .env("PATH", &bin)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let recovered = store.load().unwrap();
        assert_eq!(recovered.state, State::ReadyToInstall);
        assert!(!recovered.install_requested);
        assert_eq!(recovered.candidate_id, original.candidate_id);
        assert_eq!(recovered.version, original.version);
        assert_eq!(recovered.package_path, original.package_path);
        assert_eq!(recovered.package_sha256, original.package_sha256);
        assert_eq!(recovered.candidate_manifest, original.candidate_manifest);
        assert!(recovered.candidate_manifest.unwrap().is_file());
        assert_eq!(
            sha256_file(&recovered.package_path.unwrap()).unwrap(),
            original.package_sha256.unwrap()
        );
    }
}

#[test]
fn stale_exit_request_is_released_without_losing_candidate() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let mut original = ready_candidate(&paths);
    original.install_requested = true;
    original.updated_at = Utc::now() - chrono::Duration::minutes(31);
    let store = StateStore::new(paths.state_file());
    store.save(&original).unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();

    let output = command(root.path())
        .env("PATH", &bin)
        .args(["daemon", "--once"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let recovered = store.load().unwrap();
    assert_eq!(recovered.state, State::ReadyToInstall);
    assert!(!recovered.install_requested);
    assert!(original.candidate_manifest.unwrap().is_file());
    assert_eq!(
        sha256_file(&original.package_path.unwrap()).unwrap(),
        original.package_sha256.unwrap()
    );
}

#[test]
fn legacy_exit_timeout_does_not_promote_incomplete_or_changed_candidates() {
    for damage in [
        "missing-state-field",
        "missing-manifest",
        "changed-package",
        "mismatched-manifest",
        "rejected-inspection",
        "symlink-package",
        "unrelated-failure",
    ] {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        let paths = test_paths(root.path());
        paths.ensure_all().unwrap();
        let mut original = ready_candidate(&paths);
        original.state = State::Failed;
        original.message = Some("timed out waiting for Factory Desktop to exit".into());
        let manifest = original.candidate_manifest.as_ref().unwrap();
        let package = original.package_path.as_ref().unwrap();
        match damage {
            "missing-state-field" => original.package_sha256 = None,
            "missing-manifest" => fs::remove_file(manifest).unwrap(),
            "changed-package" => {
                let mut bytes = fs::read(package).unwrap();
                bytes[0] ^= 1;
                fs::write(package, bytes).unwrap();
            }
            "mismatched-manifest" | "rejected-inspection" => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
                if damage == "mismatched-manifest" {
                    value["version"] = json!("0.141.0");
                } else {
                    value["inspection"] = json!({"valid": false});
                }
                fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            "symlink-package" => {
                let target = root.path().join("outside.deb");
                fs::rename(package, &target).unwrap();
                std::os::unix::fs::symlink(target, package).unwrap();
            }
            "unrelated-failure" => {
                original.message = Some("candidate rejected: package inspection failed".into());
            }
            _ => unreachable!(),
        }
        let store = StateStore::new(paths.state_file());
        store.save(&original).unwrap();
        let output = command(root.path())
            .args(["status", "--json"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{damage}");
        let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(status["linuxState"], "failed", "{damage}");
        assert_eq!(store.load().unwrap(), original, "{damage}");
    }
}

#[test]
fn explicit_discard_removes_a_ready_candidate_and_returns_to_idle() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let (manifest, package) = candidate(&paths, "candidate-142", "0.142.0");
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::ReadyToInstall,
            candidate_id: Some("candidate-142".into()),
            version: Some("0.142.0".into()),
            package_path: Some(package.clone()),
            package_sha256: Some(sha256_file(&package).unwrap()),
            candidate_manifest: Some(manifest.clone()),
            ..StateRecord::default()
        })
        .unwrap();

    let output = command(root.path())
        .arg("discard-candidate")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = store.load().unwrap();
    assert_eq!(state.state, State::Idle);
    assert_eq!(state.candidate_id, None);
    assert_eq!(state.version, None);
    assert!(!manifest.exists());
    assert!(!package.exists());
}

#[test]
fn deb_wrapper_revision_does_not_trigger_a_same_factory_version_build() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let query = bin.join("dpkg-query");
    fs::write(&query, "#!/bin/sh\nprintf '0.142.0-5'\n").unwrap();
    fs::set_permissions(&query, fs::Permissions::from_mode(0o755)).unwrap();

    let output = command(root.path())
        .env("PATH", &bin)
        .args(["check-now", "--version", "0.142.0", "--format", "deb"])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = StateStore::new(paths.state_file()).load().unwrap();
    assert_eq!(state.state, State::Idle);
    assert_eq!(state.version, None);
    assert!(paths.workspaces_dir().read_dir().unwrap().next().is_none());
}

#[test]
fn update_rejects_a_duplicate_install_request() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("home")).unwrap();
    let paths = test_paths(root.path());
    paths.ensure_all().unwrap();
    let (manifest, package) = candidate(&paths, "candidate-140", "0.140.0");
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state: State::ReadyToInstall,
            candidate_id: Some("candidate-140".into()),
            version: Some("0.140.0".into()),
            package_path: Some(package),
            package_sha256: Some("a".repeat(64)),
            candidate_manifest: Some(manifest),
            install_requested: true,
            ..StateRecord::default()
        })
        .unwrap();
    let output = command(root.path())
        .args(["update", "--pid", "4242"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(store.load().unwrap().state, State::ReadyToInstall);
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
