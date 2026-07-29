use factory_update_manager::cache::{sha256_file, DmgCache, Workspace};
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
fn cleanup_keeps_only_a_ready_candidate_workspace() {
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(root.path())).unwrap();
    paths.ensure_all().unwrap();
    let candidate = paths.workspaces_dir().join("candidate-139");
    let stale = paths.workspaces_dir().join("candidate-138");
    fs::create_dir_all(&candidate).unwrap();
    fs::create_dir_all(&stale).unwrap();

    let ready = StateRecord {
        state: State::ReadyPendingExit,
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
        State::ReadyPendingExit,
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
