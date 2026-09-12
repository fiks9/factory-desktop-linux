use crate::builder::load_candidate_manifest;
use crate::cache::sha256_file;
use crate::paths::Paths;
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

pub fn recover_interrupted_operation(
    paths: &Paths,
    state: &mut StateRecord,
    now: DateTime<Utc>,
) -> bool {
    let failed_exit_wait = state.state == State::Failed
        && matches!(
            state.message.as_deref(),
            Some("timed out waiting for Factory Desktop to exit")
                | Some("interrupted ready-to-install operation became stale and was stopped")
        );
    if !(is_stale(state, now)
        || failed_exit_wait && retained_candidate_is_valid(paths, state).unwrap_or(false))
    {
        return false;
    }
    let previous = state.state;
    let retain_candidate = previous == State::ReadyToInstall || failed_exit_wait;
    state.state = if retain_candidate {
        State::ReadyToInstall
    } else {
        State::Failed
    };
    state.install_requested = false;
    state.manual_action_required = false;
    state.relaunch_pending = false;
    state.relaunch_error = None;
    state.message = Some(if retain_candidate {
        state.manual_command = None;
        "interrupted exit wait was stopped; the validated update remains ready to retry".into()
    } else {
        format!(
            "interrupted {} operation became stale and was stopped",
            serde_json::to_value(previous)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "update".into())
        )
    });
    state.updated_at = now;
    true
}

fn retained_candidate_is_valid(paths: &Paths, state: &StateRecord) -> Result<bool, Error> {
    let (Some(id), Some(version), Some(package), Some(digest), Some(manifest)) = (
        state.candidate_id.as_deref(),
        state.version.as_deref(),
        state.package_path.as_deref(),
        state.package_sha256.as_deref(),
        state.candidate_manifest.as_deref(),
    ) else {
        return Ok(false);
    };
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || crate::upstream::parse_version(version).is_err()
        || !package.is_absolute()
        || !manifest.is_absolute()
    {
        return Ok(false);
    }
    let workspace = fs::canonicalize(paths.workspaces_dir())?.join(id);
    if !fs::symlink_metadata(&workspace)?.file_type().is_dir()
        || !fs::symlink_metadata(manifest)?.file_type().is_file()
        || fs::canonicalize(manifest)? != workspace.join("validated-candidate.json")
    {
        return Ok(false);
    }
    let metadata = fs::symlink_metadata(package)?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || !fs::canonicalize(package)?.starts_with(&workspace)
    {
        return Ok(false);
    }
    let candidate = load_candidate_manifest(manifest)?;
    Ok(candidate.candidate_id == id
        && candidate.version == version
        && candidate.package_path == package
        && candidate.package_sha256 == digest
        && candidate.package_bytes == metadata.len()
        && package.extension().and_then(|value| value.to_str())
            == Some(candidate.format.extension())
        && candidate.inspection.is_object()
        && candidate.inspection.get("valid") != Some(&serde_json::Value::Bool(false))
        && sha256_file(package)? == digest)
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
