use crate::state::sync_directory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedDmg {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct DmgCache {
    directory: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionIndex {
    schema_version: u32,
    versions: BTreeMap<String, String>,
}

impl DmgCache {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn cache_pinned(&self, source: &Path) -> io::Result<CachedDmg> {
        if !source.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pinned DMG path must be absolute",
            ));
        }
        let metadata = fs::symlink_metadata(source)?;
        if !metadata.file_type().is_file() || metadata.len() == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pinned DMG must be a non-empty regular file",
            ));
        }
        fs::create_dir_all(&self.directory)?;
        let digest = sha256_file(source)?;
        let destination = self.directory.join(format!("Factory-{digest}.dmg"));
        if destination.exists() {
            if sha256_file(&destination)? != digest {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "content-addressed cache collision",
                ));
            }
        } else {
            let partial = self
                .directory
                .join(format!(".Factory-{}-{digest}.partial", std::process::id()));
            let publish = (|| {
                let mut input = File::open(source)?;
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .mode(0o600)
                    .open(&partial)?;
                io::copy(&mut input, &mut output)?;
                output.sync_all()?;
                fs::rename(&partial, &destination)?;
                sync_directory(&self.directory)
            })();
            if publish.is_err() {
                let _ = fs::remove_file(&partial);
            }
            publish?;
        }
        Ok(CachedDmg {
            path: destination,
            sha256: digest,
            bytes: metadata.len(),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn version_index_path(&self) -> PathBuf {
        self.directory.join("version-index.json")
    }

    fn read_version_index(&self) -> io::Result<VersionIndex> {
        let path = self.version_index_path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(VersionIndex {
                    schema_version: 1,
                    versions: BTreeMap::new(),
                });
            }
            Err(error) => return Err(error),
        };
        if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "accepted version index must be a bounded regular file",
            ));
        }
        let index: VersionIndex = serde_json::from_reader(File::open(path)?)?;
        if index.schema_version != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "accepted version index schema is invalid",
            ));
        }
        for (version, digest) in &index.versions {
            crate::upstream::parse_version(version)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
            validate_digest(digest)?;
        }
        Ok(index)
    }

    pub fn lookup_accepted_version(&self, version: &str) -> io::Result<Option<CachedDmg>> {
        let version = crate::upstream::parse_version(version)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        let index = self.read_version_index()?;
        let Some(digest) = index.versions.get(&version) else {
            return Ok(None);
        };
        let path = self.directory.join(format!("Factory-{digest}.dmg"));
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !metadata.file_type().is_file() || metadata.len() == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "indexed DMG must be a non-empty regular file",
            ));
        }
        if sha256_file(&path)? != *digest {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cached DMG hash mismatch for Factory {version}"),
            ));
        }
        Ok(Some(CachedDmg {
            path,
            sha256: digest.clone(),
            bytes: metadata.len(),
        }))
    }

    pub fn record_accepted_version(&self, version: &str, digest: &str) -> io::Result<()> {
        let version = crate::upstream::parse_version(version)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        validate_digest(digest)?;
        fs::create_dir_all(&self.directory)?;
        let artifact = self.directory.join(format!("Factory-{digest}.dmg"));
        let metadata = fs::symlink_metadata(&artifact)?;
        if !metadata.file_type().is_file()
            || metadata.len() == 0
            || sha256_file(&artifact)? != digest
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "accepted version index cannot reference an unverified DMG",
            ));
        }
        let mut index = self.read_version_index()?;
        index.versions.insert(version, digest.to_owned());
        let temporary = self.directory.join(format!(
            ".version-index-{}-{}.partial",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let publish = (|| {
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            serde_json::to_writer_pretty(&mut output, &index)?;
            use std::io::Write;
            output.write_all(b"\n")?;
            output.sync_all()?;
            fs::rename(&temporary, self.version_index_path())?;
            sync_directory(&self.directory)
        })();
        if publish.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        publish
    }

    pub(crate) fn create_partial(&self) -> io::Result<(PathBuf, File)> {
        fs::create_dir_all(&self.directory)?;
        let path = self.directory.join(format!(
            ".Factory-{}-{}.partial",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        Ok((path, file))
    }

    pub(crate) fn publish_download(
        &self,
        partial: &Path,
        sha256: &str,
        bytes: u64,
    ) -> io::Result<CachedDmg> {
        if bytes == 0 || sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "download digest or size is invalid",
            ));
        }
        let destination = self.directory.join(format!("Factory-{sha256}.dmg"));
        if destination.exists() {
            if sha256_file(&destination)? != sha256 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "content-addressed cache collision",
                ));
            }
            fs::remove_file(partial)?;
        } else {
            fs::rename(partial, &destination)?;
            sync_directory(&self.directory)?;
        }
        Ok(CachedDmg {
            path: destination,
            sha256: sha256.to_owned(),
            bytes,
        })
    }
}

fn validate_digest(digest: &str) -> io::Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "accepted version index digest must be a lowercase SHA-256",
        ));
    }
    Ok(())
}

/// Derive a confined workspace identifier from a validated content digest.
///
/// Candidate identifiers must not contain a version string: semantic versions
/// contain dots, while workspace names deliberately allow only safe path
/// segment characters. The complete lowercase SHA-256 keeps the identifier
/// collision-resistant without weakening that confinement rule.
pub fn candidate_id_for_digest(digest: &str) -> io::Result<String> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "candidate digest must be a lowercase SHA-256",
        ));
    }
    Ok(format!("candidate-{digest}"))
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut input = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        Digest::update(&mut hash, &buffer[..read]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub struct Workspace {
    path: PathBuf,
    cleanup: bool,
}

impl Workspace {
    pub fn create(root: &Path, candidate_id: &str) -> io::Result<Self> {
        if candidate_id.is_empty()
            || !candidate_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid candidate id",
            ));
        }
        fs::create_dir_all(root)?;
        let path = root.join(candidate_id);
        fs::create_dir(&path)?;
        Ok(Self {
            path,
            cleanup: true,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn persist(&mut self) {
        self.cleanup = false;
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
