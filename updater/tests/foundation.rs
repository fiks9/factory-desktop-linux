use factory_update_manager::cache::{candidate_id_for_digest, sha256_file, DmgCache, Workspace};
use factory_update_manager::cleanup::cleanup;
use factory_update_manager::daemon::{
    blocks_new_candidate, read_check_interval_seconds, DEFAULT_CHECK_INTERVAL_SECONDS,
};
use factory_update_manager::locks::UpdateLock;
use factory_update_manager::paths::Paths;
use factory_update_manager::state::{State, StateRecord, StateStore};
use std::fs;

#[test]
fn paths_stay_below_the_test_root() {
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(root.path())).unwrap();
    paths.ensure_all().unwrap();

    assert!(paths.state_file().starts_with(root.path()));
    assert!(paths.downloads_dir().is_dir());
    assert!(paths.workspaces_dir().is_dir());
}

#[test]
fn state_is_written_atomically_and_round_trips() {
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(root.path())).unwrap();
    let store = StateStore::new(paths.state_file());
    let record = StateRecord {
        state: State::Downloading,
        version: Some("0.139.0".into()),
        ..StateRecord::default()
    };

    store.save(&record).unwrap();

    assert_eq!(store.load().unwrap(), record);
    let leftovers: Vec<_> = fs::read_dir(paths.state_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("partial"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn corrupt_state_is_an_error_instead_of_idle() {
    let root = tempfile::tempdir().unwrap();
    let state_file = root.path().join("state.json");
    fs::write(&state_file, "not-json").unwrap();

    assert!(StateStore::new(state_file).load().is_err());
}

#[test]
fn schema_one_state_migrates_to_schema_two_defaults() {
    let root = tempfile::tempdir().unwrap();
    let state_file = root.path().join("state.json");
    fs::write(
        &state_file,
        r#"{
  "schema_version": 1,
  "state": "ready-pending-exit",
  "updated_at": "2026-07-30T00:00:00Z",
  "candidate_id": "candidate-139",
  "version": "0.139.0",
  "manual_action_required": false
}"#,
    )
    .unwrap();

    let state = StateStore::new(state_file).load().unwrap();

    assert_eq!(state.schema_version, 2);
    assert_eq!(state.state, State::ReadyToInstall);
    assert_eq!(state.candidate_id.as_deref(), Some("candidate-139"));
    assert_eq!(state.manual_command, None);
    assert_eq!(state.notification_dedupe_key, None);
    assert!(!state.install_requested);
    assert_eq!(state.approval_id, None);
    assert_eq!(state.approval_expires_at, None);
    assert!(!state.relaunch_pending);
    assert_eq!(state.relaunch_error, None);
}

#[test]
fn update_lock_is_exclusive() {
    let root = tempfile::tempdir().unwrap();
    let lock_path = root.path().join("manager.lock");
    let _first = UpdateLock::acquire(&lock_path).unwrap();

    assert!(UpdateLock::acquire(&lock_path).is_err());
}

#[test]
fn pinned_dmg_is_published_by_digest() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.dmg");
    fs::write(&source, b"authorized fixture").unwrap();
    let cache = DmgCache::new(root.path().join("downloads"));

    let cached = cache.cache_pinned(&source).unwrap();

    assert_eq!(cached.sha256, sha256_file(&source).unwrap());
    assert_eq!(fs::read(&cached.path).unwrap(), b"authorized fixture");
    assert_eq!(
        cached.path.file_name().unwrap().to_string_lossy(),
        format!("Factory-{}.dmg", cached.sha256)
    );
}

#[test]
fn rejected_workspace_is_removed_but_persisted_workspace_remains() {
    let root = tempfile::tempdir().unwrap();
    let rejected_path;
    {
        let workspace = Workspace::create(root.path(), "rejected").unwrap();
        rejected_path = workspace.path().to_path_buf();
    }
    assert!(!rejected_path.exists());

    let accepted_path;
    {
        let mut workspace = Workspace::create(root.path(), "accepted").unwrap();
        accepted_path = workspace.path().to_path_buf();
        workspace.persist();
    }
    assert!(accepted_path.exists());
}

#[test]
fn production_dotted_version_candidate_uses_safe_digest_id() {
    let root = tempfile::tempdir().unwrap();
    let digest = "fcc9180c74d493aa418f445f3bc61099d53dd96a6f07451569cd4c2bbb239228";
    let legacy_id = format!("0.140.0-{}", &digest[..12]);
    assert!(Workspace::create(root.path(), &legacy_id).is_err());

    let candidate_id = candidate_id_for_digest(digest).unwrap();

    assert_eq!(candidate_id, format!("candidate-{digest}"));
    let workspace = Workspace::create(root.path(), &candidate_id).unwrap();
    assert!(workspace.path().starts_with(root.path()));
}

#[test]
fn candidate_digest_requires_exact_lowercase_sha256() {
    let valid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert_eq!(
        candidate_id_for_digest(valid).unwrap(),
        format!("candidate-{valid}")
    );

    for invalid in [
        "",
        "0123456789abcdef",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEf",
        "../0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/..",
    ] {
        assert!(
            candidate_id_for_digest(invalid).is_err(),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn cleanup_keeps_only_a_ready_candidate_workspace() {
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(root.path())).unwrap();
    paths.ensure_all().unwrap();
    let candidate = paths.workspaces_dir().join("candidate-139");
    let stale = paths.workspaces_dir().join("candidate-138");
    fs::create_dir_all(&candidate).unwrap();
    fs::create_dir_all(&stale).unwrap();

    let ready = StateRecord {
        state: State::ReadyToInstall,
        candidate_id: Some("candidate-139".into()),
        ..StateRecord::default()
    };
    cleanup(&paths, &ready).unwrap();
    assert!(candidate.exists());
    assert!(!stale.exists());

    let installed = StateRecord {
        state: State::Installed,
        candidate_id: Some("candidate-139".into()),
        ..StateRecord::default()
    };
    cleanup(&paths, &installed).unwrap();
    assert!(!candidate.exists());
}

#[test]
fn daemon_interval_defaults_to_six_hours_and_is_configurable() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config.toml");

    assert_eq!(
        read_check_interval_seconds(&config).unwrap(),
        DEFAULT_CHECK_INTERVAL_SECONDS
    );
    fs::write(&config, "check_interval_seconds = 900\n").unwrap();
    assert_eq!(read_check_interval_seconds(&config).unwrap(), 900);
    fs::write(&config, "check_interval_seconds = 5\n").unwrap();
    assert!(read_check_interval_seconds(&config).is_err());
}

#[test]
fn daemon_blocks_candidate_replacement_for_pending_install_states() {
    for state in [
        State::ReadyToInstall,
        State::Installing,
        State::InstallFailedManualAction,
    ] {
        assert!(blocks_new_candidate(state));
    }
    for state in [
        State::Idle,
        State::Installed,
        State::RolledBack,
        State::Failed,
    ] {
        assert!(!blocks_new_candidate(state));
    }
}

#[test]
fn cleanup_retains_installing_and_manual_candidates_but_removes_idle_and_installed() {
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(root.path())).unwrap();
    paths.ensure_all().unwrap();

    for state in [State::Installing, State::InstallFailedManualAction] {
        let candidate = paths.workspaces_dir().join("candidate-139");
        let stale = paths.workspaces_dir().join("candidate-138");
        fs::create_dir_all(&candidate).unwrap();
        fs::create_dir_all(&stale).unwrap();
        cleanup(
            &paths,
            &StateRecord {
                state,
                candidate_id: Some("candidate-139".into()),
                ..StateRecord::default()
            },
        )
        .unwrap();
        assert!(candidate.exists());
        assert!(!stale.exists());
    }

    for state in [State::Idle, State::Installed] {
        let stale = paths.workspaces_dir().join("candidate-139");
        fs::create_dir_all(&stale).unwrap();
        cleanup(
            &paths,
            &StateRecord {
                state,
                candidate_id: Some("candidate-139".into()),
                ..StateRecord::default()
            },
        )
        .unwrap();
        assert!(!stale.exists());
    }
}
