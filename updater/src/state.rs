use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Idle,
    Checking,
    UpdateAvailable,
    Downloading,
    Building,
    Validating,
    ReadyToInstall,
    Installing,
    Installed,
    InstallFailedManualAction,
    RolledBack,
    Failed,
}

impl<'de> Deserialize<'de> for State {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "idle" => Ok(Self::Idle),
            "checking" => Ok(Self::Checking),
            "update-available" => Ok(Self::UpdateAvailable),
            "downloading" => Ok(Self::Downloading),
            "building" => Ok(Self::Building),
            "validating" => Ok(Self::Validating),
            "ready-to-install" | "ready-pending-exit" => Ok(Self::ReadyToInstall),
            "installing" => Ok(Self::Installing),
            "installed" => Ok(Self::Installed),
            "install-failed-manual-action" => Ok(Self::InstallFailedManualAction),
            "rolled-back" => Ok(Self::RolledBack),
            "failed" => Ok(Self::Failed),
            _ => Err(serde::de::Error::custom(format!(
                "unknown updater state: {value}"
            ))),
        }
    }
}

impl State {
    pub fn is_preparation_active(self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Downloading | Self::Building | Self::Validating
        )
    }

    pub fn requires_candidate(self) -> bool {
        matches!(
            self,
            Self::ReadyToInstall | Self::Installing | Self::InstallFailedManualAction
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateRecord {
    pub schema_version: u32,
    pub state: State,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_manifest: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub manual_action_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_dedupe_key: Option<String>,
    #[serde(default)]
    pub install_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub relaunch_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaunch_error: Option<String>,
}

impl Default for StateRecord {
    fn default() -> Self {
        Self {
            schema_version: 2,
            state: State::Idle,
            updated_at: Utc::now(),
            available_version: None,
            candidate_id: None,
            version: None,
            package_path: None,
            package_sha256: None,
            candidate_manifest: None,
            message: None,
            manual_action_required: false,
            manual_command: None,
            notification_dedupe_key: None,
            install_requested: false,
            approval_id: None,
            approval_expires_at: None,
            relaunch_pending: false,
            relaunch_error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<StateRecord, Box<dyn std::error::Error + Send + Sync>> {
        if !self.path.exists() {
            return Ok(StateRecord::default());
        }
        let bytes = fs::read(&self.path)?;
        let mut record: StateRecord = serde_json::from_slice(&bytes)?;
        if record.schema_version == 1 {
            record.schema_version = 2;
        } else if record.schema_version != 2 {
            return Err(format!(
                "unsupported state schema version: {}",
                record.schema_version
            )
            .into());
        }
        Ok(record)
    }

    pub fn save(&self, record: &StateRecord) -> io::Result<()> {
        if record.schema_version != 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "state writes require schema version 2",
            ));
        }
        let parent = self.path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "state path has no parent directory",
            )
        })?;
        fs::create_dir_all(parent)?;
        let partial = parent.join(format!(
            ".state-{}-{}.partial",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&partial)?;
        let result = (|| {
            serde_json::to_writer_pretty(&mut output, record).map_err(io::Error::other)?;
            output.write_all(b"\n")?;
            output.sync_all()?;
            fs::rename(&partial, &self.path)?;
            sync_directory(parent)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result
    }
}

pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    match File::open(path).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EINVAL) | Some(libc::EISDIR)
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}
