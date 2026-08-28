use crate::locks::UpdateLock;
use crate::paths::Paths;
use crate::state::{State, StateStore};
use std::time::Duration;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub struct AfterExitOptions {
    pub parent_pid: u32,
    pub timeout: Duration,
    pub poll_interval: Duration,
    pub launcher: std::path::PathBuf,
}

pub trait AfterExitBackend {
    fn factory_running(&self, parent_pid: u32) -> bool;
    fn wait(&self, duration: Duration);
    fn install_ready(&self) -> Result<State, Error>;
    fn relaunch(&self, launcher: &std::path::Path) -> Result<(), Error>;
}

pub fn run_after_exit(
    paths: &Paths,
    store: &StateStore,
    options: &AfterExitOptions,
    backend: &dyn AfterExitBackend,
) -> Result<(), Error> {
    let _after_exit_lock = UpdateLock::acquire(&paths.after_exit_lock_file())?;
    let mut elapsed = Duration::ZERO;
    while backend.factory_running(options.parent_pid) {
        if elapsed >= options.timeout {
            return fail_request(
                paths,
                store,
                "timed out waiting for Factory Desktop to exit",
            );
        }
        backend.wait(options.poll_interval);
        elapsed = elapsed.saturating_add(options.poll_interval);
    }

    let outcome = backend.install_ready()?;
    mutate_locked(paths, store, |state| {
        state.state = outcome;
        state.install_requested = false;
        state.manual_action_required = outcome == State::InstallFailedManualAction;
        state.relaunch_pending = matches!(outcome, State::Installed | State::RolledBack);
        state.relaunch_error = None;
        state.updated_at = chrono::Utc::now();
    })?;
    if !matches!(outcome, State::Installed | State::RolledBack) {
        return Ok(());
    }
    if let Err(error) = backend.relaunch(&options.launcher) {
        mutate_locked(paths, store, |state| {
            state.relaunch_pending = false;
            state.relaunch_error = Some(format!(
                "update installed but Factory Desktop could not relaunch: {error}"
            ));
        })?;
        return Err(error);
    }
    mutate_locked(paths, store, |state| {
        state.relaunch_pending = false;
        state.relaunch_error = None;
    })?;
    Ok(())
}

fn fail_request(paths: &Paths, store: &StateStore, message: &str) -> Result<(), Error> {
    mutate_locked(paths, store, |state| {
        state.install_requested = false;
        state.relaunch_pending = false;
        state.relaunch_error = Some(message.into());
    })?;
    Err(message.into())
}

fn mutate_locked(
    paths: &Paths,
    store: &StateStore,
    mutation: impl FnOnce(&mut crate::state::StateRecord),
) -> Result<(), Error> {
    let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
    let mut state = store.load()?;
    mutation(&mut state);
    store.save(&state)?;
    Ok(())
}
