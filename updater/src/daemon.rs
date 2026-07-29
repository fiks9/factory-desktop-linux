use crate::state::State;
use std::fs;
use std::path::Path;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub const DEFAULT_CHECK_INTERVAL_SECONDS: u64 = 21_600;
const MINIMUM_CHECK_INTERVAL_SECONDS: u64 = 60;

pub fn blocks_new_candidate(state: State) -> bool {
    matches!(
        state,
        State::ReadyPendingExit | State::Installing | State::InstallFailedManualAction
    )
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
