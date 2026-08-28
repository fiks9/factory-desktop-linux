use factory_update_manager::after_exit::{run_after_exit, AfterExitBackend, AfterExitOptions};
use factory_update_manager::paths::Paths;
use factory_update_manager::state::{State, StateRecord, StateStore};
use std::cell::{Cell, RefCell};
use std::path::Path;
use std::time::Duration;

struct FakeBackend {
    running_checks: RefCell<Vec<bool>>,
    outcome: State,
    installs: Cell<usize>,
    relaunches: Cell<usize>,
    relaunch_fails: Cell<bool>,
}

impl FakeBackend {
    fn new(checks: Vec<bool>, outcome: State) -> Self {
        Self {
            running_checks: RefCell::new(checks),
            outcome,
            installs: Cell::new(0),
            relaunches: Cell::new(0),
            relaunch_fails: Cell::new(false),
        }
    }
}

impl AfterExitBackend for FakeBackend {
    fn factory_running(&self, _parent_pid: u32) -> bool {
        let mut checks = self.running_checks.borrow_mut();
        if checks.is_empty() {
            false
        } else {
            checks.remove(0)
        }
    }

    fn wait(&self, _duration: Duration) {}

    fn install_ready(&self) -> Result<State, factory_update_manager::after_exit::Error> {
        self.installs.set(self.installs.get() + 1);
        Ok(self.outcome)
    }

    fn relaunch(&self, launcher: &Path) -> Result<(), factory_update_manager::after_exit::Error> {
        assert_eq!(launcher, Path::new("/opt/Factory/factory-desktop-launcher"));
        self.relaunches.set(self.relaunches.get() + 1);
        if self.relaunch_fails.get() {
            Err("fake relaunch failed".into())
        } else {
            Ok(())
        }
    }
}

fn setup(state: State) -> (tempfile::TempDir, Paths, StateStore) {
    let root = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(root.path())).unwrap();
    paths.ensure_all().unwrap();
    let store = StateStore::new(paths.state_file());
    store
        .save(&StateRecord {
            state,
            install_requested: true,
            version: Some("0.140.0".into()),
            ..StateRecord::default()
        })
        .unwrap();
    (root, paths, store)
}

fn options() -> AfterExitOptions {
    AfterExitOptions {
        parent_pid: 4242,
        timeout: Duration::from_secs(3),
        poll_interval: Duration::from_secs(1),
        launcher: "/opt/Factory/factory-desktop-launcher".into(),
    }
}

#[test]
fn install_waits_for_exit_then_relaunches_verified_install_once() {
    let (_root, paths, store) = setup(State::ReadyToInstall);
    let backend = FakeBackend::new(vec![true, true, false], State::Installed);

    run_after_exit(&paths, &store, &options(), &backend).unwrap();

    assert_eq!(backend.installs.get(), 1);
    assert_eq!(backend.relaunches.get(), 1);
    let state = store.load().unwrap();
    assert_eq!(state.state, State::Installed);
    assert!(!state.install_requested);
    assert!(!state.relaunch_pending);
    assert_eq!(state.relaunch_error, None);
}

#[test]
fn rollback_relaunches_once_but_manual_action_never_relaunches() {
    let (_root, paths, store) = setup(State::ReadyToInstall);
    let rollback = FakeBackend::new(vec![false], State::RolledBack);
    run_after_exit(&paths, &store, &options(), &rollback).unwrap();
    assert_eq!(rollback.relaunches.get(), 1);
    assert_eq!(store.load().unwrap().state, State::RolledBack);

    store
        .save(&StateRecord {
            state: State::ReadyToInstall,
            install_requested: true,
            ..StateRecord::default()
        })
        .unwrap();
    let manual = FakeBackend::new(vec![false], State::InstallFailedManualAction);
    run_after_exit(&paths, &store, &options(), &manual).unwrap();
    assert_eq!(manual.installs.get(), 1);
    assert_eq!(manual.relaunches.get(), 0);
    assert_eq!(
        store.load().unwrap().state,
        State::InstallFailedManualAction
    );
}

#[test]
fn bounded_wait_times_out_without_install_or_relaunch() {
    let (_root, paths, store) = setup(State::ReadyToInstall);
    let backend = FakeBackend::new(vec![true, true, true, true], State::Installed);

    assert!(run_after_exit(&paths, &store, &options(), &backend).is_err());

    assert_eq!(backend.installs.get(), 0);
    assert_eq!(backend.relaunches.get(), 0);
    let state = store.load().unwrap();
    assert_eq!(state.state, State::ReadyToInstall);
    assert!(!state.install_requested);
    assert!(state.relaunch_error.unwrap().contains("timed out"));
}

#[test]
fn relaunch_failure_preserves_verified_state_and_records_actionable_error() {
    let (_root, paths, store) = setup(State::ReadyToInstall);
    let backend = FakeBackend::new(vec![false], State::Installed);
    backend.relaunch_fails.set(true);

    assert!(run_after_exit(&paths, &store, &options(), &backend).is_err());

    let state = store.load().unwrap();
    assert_eq!(state.state, State::Installed);
    assert!(!state.relaunch_pending);
    assert!(state
        .relaunch_error
        .unwrap()
        .contains("fake relaunch failed"));
    assert_eq!(backend.relaunches.get(), 1);
}

#[test]
fn duplicate_after_exit_helper_is_blocked_by_a_separate_lock() {
    let (_root, paths, store) = setup(State::ReadyToInstall);
    let _lock =
        factory_update_manager::locks::UpdateLock::acquire(&paths.after_exit_lock_file()).unwrap();
    let backend = FakeBackend::new(vec![false], State::Installed);

    assert!(run_after_exit(&paths, &store, &options(), &backend).is_err());
    assert_eq!(backend.installs.get(), 0);
}
