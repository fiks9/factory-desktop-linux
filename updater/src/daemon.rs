use crate::state::{State, StateRecord};
use chrono::{DateTime, Utc};
use std::fs;
use std::path::Path;
use std::time::Duration;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub const DEFAULT_CHECK_INTERVAL_SECONDS: u64 = 21_600;
const MINIMUM_CHECK_INTERVAL_SECONDS: u64 = 60;
pub const STALE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub fn blocks_new_candidate(state: State) -> bool {
    matches!(
        state,
        State::Checking
            | State::Downloading
            | State::Building
            | State::Validating
            | State::ReadyToInstall
            | State::Installing
            | State::InstallFailedManualAction
    )
}

pub fn is_stale(state: &StateRecord, now: DateTime<Utc>) -> bool {
    let active = state.state.is_preparation_active()
        || (state.state == State::ReadyToInstall && state.install_requested);
    if !active || state.updated_at > now {
        return false;
    }
    (now - state.updated_at)
        .to_std()
        .is_ok_and(|age| age >= STALE_OPERATION_TIMEOUT)
}

pub fn recover_stale_state(state: &mut StateRecord, now: DateTime<Utc>) -> bool {
    if !is_stale(state, now) {
        return false;
    }
    let previous = state.state;
    state.state = State::Failed;
    state.install_requested = false;
    state.manual_action_required = false;
    state.relaunch_pending = false;
    state.relaunch_error = None;
    state.message = Some(format!(
        "interrupted {} operation became stale and was stopped",
        serde_json::to_value(previous)
            .ok()
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .unwrap_or_else(|| "update".into())
    ));
    state.updated_at = now;
    true
}

pub fn read_check_interval_seconds(config: &Path) -> Result<u64, Error> {
    if !config.exists() {
        return Ok(DEFAULT_CHECK_INTERVAL_SECONDS);
    }
    let mut interval = DEFAULT_CHECK_INTERVAL_SECONDS;
    for line in fs::read_to_string(config)?.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "check_interval_seconds" {
            continue;
        }
        interval = value.trim().parse()?;
        if interval < MINIMUM_CHECK_INTERVAL_SECONDS {
            return Err(format!(
                "check_interval_seconds must be at least {MINIMUM_CHECK_INTERVAL_SECONDS}"
            )
            .into());
        }
    }
    Ok(interval)
}
