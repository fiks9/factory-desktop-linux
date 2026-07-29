use crate::builder::{PackageFormat, ValidatedCandidate};
use crate::cache::sha256_file;
use crate::state::sync_directory;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnownGoodArtifact {
    pub candidate_id: String,
    pub version: String,
    pub format: PackageFormat,
    pub package_path: PathBuf,
    pub package_sha256: String,
    pub retained_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct KnownGoodStore {
    root: PathBuf,
    limit: usize,
}

impl KnownGoodStore {
    pub fn new(root: PathBuf, limit: usize) -> Self {
        Self {
            root,
            limit: limit.max(1),
        }
    }

    pub fn list(&self) -> Result<Vec<KnownGoodArtifact>, Error> {
        let index = self.root.join("index.json");
        if !index.exists() {
            return Ok(Vec::new());
        }
        let entries: Vec<KnownGoodArtifact> = serde_json::from_slice(&fs::read(index)?)?;
        for entry in &entries {
            if !entry.package_path.is_file()
                || sha256_file(&entry.package_path)? != entry.package_sha256
            {
                return Err(format!(
                    "known-good package is missing or corrupted: {}",
                    entry.package_path.display()
                )
                .into());
            }
        }
        Ok(entries)
    }

    pub fn latest(&self) -> Result<Option<KnownGoodArtifact>, Error> {
        Ok(self
            .list()?
            .into_iter()
            .max_by_key(|entry| entry.retained_at))
    }

    pub fn retain(&self, candidate: &ValidatedCandidate) -> Result<KnownGoodArtifact, Error> {
        crate::upstream::parse_version(&candidate.version)?;
        if candidate.candidate_id.is_empty()
            || !candidate.candidate_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("candidate id contains unsafe path characters".into());
        }
        fs::create_dir_all(&self.root)?;
        fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        remove_partial_files(&self.root)?;
        let source = fs::canonicalize(&candidate.package_path)?;
        if !source.is_file() || sha256_file(&source)? != candidate.package_sha256 {
            return Err("cannot retain a missing or hash-mismatched package".into());
        }
        let destination = self.root.join(format!(
            "{}-{}-{}.{}",
            candidate.candidate_id,
            candidate.version,
            candidate.package_sha256,
            candidate.format.extension()
        ));
        if !destination.exists() {
            let partial = self
                .root
                .join(format!(".retain-{}.partial", std::process::id()));
            let publish = (|| -> io::Result<()> {
                let mut input = fs::File::open(&source)?;
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .mode(0o600)
                    .open(&partial)?;
                io::copy(&mut input, &mut output)?;
                output.sync_all()?;
                fs::rename(&partial, &destination)?;
                sync_directory(&self.root)
            })();
            if publish.is_err() {
                let _ = fs::remove_file(&partial);
            }
            publish?;
        }
        let artifact = KnownGoodArtifact {
            candidate_id: candidate.candidate_id.clone(),
            version: candidate.version.clone(),
            format: candidate.format,
            package_path: fs::canonicalize(destination)?,
            package_sha256: candidate.package_sha256.clone(),
            retained_at: Utc::now(),
        };
        let mut entries = self.list()?;
        entries.retain(|entry| entry.package_sha256 != artifact.package_sha256);
        entries.push(artifact.clone());
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.retained_at));
        let stale = if entries.len() > self.limit {
            entries.split_off(self.limit)
        } else {
            Vec::new()
        };
        write_index(&self.root, &entries)?;
        for entry in stale {
            let _ = fs::remove_file(entry.package_path);
        }
        sync_directory(&self.root)?;
        Ok(artifact)
    }
}

fn write_index(root: &Path, entries: &[KnownGoodArtifact]) -> io::Result<()> {
    let target = root.join("index.json");
    let partial = root.join(format!(".index-{}.partial", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&partial)?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, entries).map_err(io::Error::other)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&partial, target)?;
        sync_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_file(partial);
    }
    result
}

fn remove_partial_files(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.file_name().to_string_lossy().ends_with(".partial")
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}
