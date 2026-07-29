use crate::cache::{CachedDmg, DmgCache};
use crate::upstream::{parse_version, version_from_url};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

type Error = Box<dyn std::error::Error + Send + Sync>;

struct PartialFile {
    path: PathBuf,
    published: bool,
}

impl PartialFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub async fn download_official(
    client: &reqwest::Client,
    url: &str,
    expected_version: &str,
    cache: &DmgCache,
) -> Result<CachedDmg, Error> {
    parse_version(expected_version)?;
    let (partial_path, output) = cache.create_partial()?;
    let mut partial = PartialFile::new(partial_path);
    let response = client
        .get(url)
        .timeout(Duration::from_secs(10 * 60))
        .send()
        .await?
        .error_for_status()?;
    if let Some(actual) = version_from_url(response.url()) {
        if actual != expected_version {
            return Err(format!(
                "Factory version changed during download: discovered {expected_version}, redirect {actual}"
            )
            .into());
        }
    }
    let expected_length = response.content_length();
    let mut output = tokio::fs::File::from_std(output);
    let mut stream = response.bytes_stream();
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        bytes = bytes
            .checked_add(chunk.len() as u64)
            .ok_or("DMG download size overflow")?;
        Digest::update(&mut hash, &chunk);
        output.write_all(&chunk).await?;
    }
    if bytes == 0 {
        return Err("DMG endpoint returned an empty body".into());
    }
    if expected_length.is_some_and(|expected| expected != bytes) {
        return Err(format!(
            "DMG content-length mismatch: expected {expected_length:?}, received {bytes}"
        )
        .into());
    }
    output.flush().await?;
    output.sync_all().await?;
    drop(output);
    let digest: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let artifact = cache.publish_download(Path::new(&partial.path), &digest, bytes)?;
    partial.published = true;
    Ok(artifact)
}
