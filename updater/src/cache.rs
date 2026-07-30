use crate::state::sync_directory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
