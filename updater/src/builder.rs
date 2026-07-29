use crate::cache::{sha256_file, Workspace};
use crate::state::sync_directory;
use crate::upstream::parse_version;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageFormat {
    Deb,
    Rpm,
}

impl PackageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Deb => "deb",
            Self::Rpm => "rpm",
        }
    }

    fn package_script(self) -> &'static str {
        match self {
            Self::Deb => "package-deb.js",
            Self::Rpm => "package-rpm.js",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BuildRequest {
    pub candidate_id: String,
    pub version: String,
    pub dmg_path: PathBuf,
    pub workspace: PathBuf,
    pub downloads: PathBuf,
    pub format: PackageFormat,
    pub environment: Vec<(OsString, OsString)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidatedCandidate {
    pub schema_version: u32,
    pub candidate_id: String,
    pub version: String,
    pub format: PackageFormat,
    pub package_path: PathBuf,
    pub package_sha256: String,
    pub package_bytes: u64,
    pub validated_at: DateTime<Utc>,
    pub inspection: Value,
    #[serde(skip)]
    pub manifest_path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct BuildOutput {
    #[serde(rename = "appDir")]
    app_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
struct PackageOutput {
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct NodeBuilder {
    root: PathBuf,
    node: PathBuf,
}

impl NodeBuilder {
    pub fn new(root: PathBuf, node: PathBuf) -> Self {
        Self { root, node }
    }

    pub fn build(&self, request: BuildRequest) -> Result<ValidatedCandidate, Error> {
        parse_version(&request.version)?;
        if !request.dmg_path.is_absolute()
            || !fs::symlink_metadata(&request.dmg_path)?
                .file_type()
                .is_file()
        {
            return Err("candidate DMG must be an absolute regular file".into());
        }
        let parent = request
            .workspace
            .parent()
            .ok_or("workspace has no parent")?;
        let name = request
            .workspace
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("workspace name is not valid UTF-8")?;
        let mut workspace = Workspace::create(parent, name)?;
        let build_dir = workspace.path().join("build");
        let artifact_dir = workspace.path().join("artifacts");
        fs::create_dir_all(&build_dir)?;
        fs::create_dir_all(&artifact_dir)?;

        let scripts = self.root.join("scripts");
        let build_output = self.run_node(
            &scripts.join("build-app.js"),
            &[
                OsString::from("--dmg"),
                request.dmg_path.clone().into_os_string(),
                OsString::from("--version"),
                request.version.clone().into(),
                OsString::from("--work-dir"),
                build_dir.clone().into_os_string(),
                OsString::from("--cache-dir"),
                request.downloads.clone().into_os_string(),
                OsString::from("--electron-cache-dir"),
                request.downloads.join("electron").into_os_string(),
            ],
            &request.environment,
        )?;
        let build: BuildOutput = parse_last_json(&build_output.stdout)?;
        let app_dir = confined_existing_path(&build.app_dir, workspace.path(), "built app")?;

        let package_output = self.run_node(
            &scripts.join(request.format.package_script()),
            &[
                app_dir.into_os_string(),
                request.version.clone().into(),
                artifact_dir.clone().into_os_string(),
            ],
            &request.environment,
        )?;
        let package: PackageOutput = parse_last_json(&package_output.stdout)?;
        let package_path =
            confined_existing_path(&package.path, workspace.path(), "candidate package")?;
        if package_path.extension().and_then(|value| value.to_str())
            != Some(request.format.extension())
        {
            return Err("candidate package extension does not match selected format".into());
        }

        let inspection_output = self.run_node(
            &scripts.join("inspect-package.js"),
            &[package_path.clone().into_os_string()],
            &request.environment,
        )?;
        let inspection: Value = parse_last_json(&inspection_output.stdout)?;
        if !inspection.is_object() {
            return Err("package inspector did not return an object".into());
        }

        let mut candidate = ValidatedCandidate {
            schema_version: 1,
            candidate_id: request.candidate_id,
            version: request.version,
            format: request.format,
            package_sha256: sha256_file(&package_path)?,
            package_bytes: fs::metadata(&package_path)?.len(),
            package_path,
            validated_at: Utc::now(),
            inspection,
            manifest_path: workspace.path().join("validated-candidate.json"),
        };
        write_manifest(&candidate.manifest_path, &candidate)?;
        candidate.manifest_path = fs::canonicalize(&candidate.manifest_path)?;
        workspace.persist();
        Ok(candidate)
    }

    fn run_node(
        &self,
        script: &Path,
        arguments: &[OsString],
        environment: &[(OsString, OsString)],
    ) -> Result<Output, Error> {
        if !script.is_file() {
            return Err(format!("update-builder script is missing: {}", script.display()).into());
        }
        let output = Command::new(&self.node)
            .arg(script)
            .args(arguments)
            .envs(environment.iter().cloned())
            .current_dir(&self.root)
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "{} failed with {}: {}",
                script.display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        Ok(output)
    }
}

fn confined_existing_path(path: &Path, workspace: &Path, label: &str) -> Result<PathBuf, Error> {
    let canonical_workspace = fs::canonicalize(workspace)?;
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(&canonical_workspace)
        || !fs::symlink_metadata(&canonical)?.file_type().is_file() && !canonical.is_dir()
    {
        return Err(format!("{label} escaped candidate workspace: {}", path.display()).into());
    }
    Ok(canonical)
}

fn parse_last_json<T: for<'de> Deserialize<'de>>(stdout: &[u8]) -> Result<T, Error> {
    for (index, byte) in stdout.iter().enumerate().rev() {
        if *byte == b'{' {
            if let Ok(value) = serde_json::from_slice(&stdout[index..]) {
                return Ok(value);
            }
        }
    }
    Err(format!(
        "subprocess did not emit a valid JSON result: {}",
        String::from_utf8_lossy(stdout)
    )
    .into())
}

fn write_manifest(path: &Path, candidate: &ValidatedCandidate) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "manifest has no parent"))?;
    let partial = parent.join(format!(".validated-{}.partial", std::process::id()));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&partial)?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut output, candidate).map_err(io::Error::other)?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        fs::rename(&partial, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(partial);
    }
    result
}

pub fn load_candidate_manifest(path: &Path) -> Result<ValidatedCandidate, Error> {
    let mut candidate: ValidatedCandidate = serde_json::from_slice(&fs::read(path)?)?;
    if candidate.schema_version != 1 {
        return Err(format!(
            "unsupported candidate manifest schema: {}",
            candidate.schema_version
        )
        .into());
    }
    candidate.manifest_path = fs::canonicalize(path)?;
    Ok(candidate)
}
