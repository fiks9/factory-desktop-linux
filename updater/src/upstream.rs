use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use std::time::Duration;

pub const LATEST_VERSION_URL: &str = "https://api.factory.ai/api/desktop/latest-version";
pub const DESKTOP_DOWNLOAD_URL: &str = "https://app.factory.ai/api/desktop";

type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Clone)]
pub struct UpstreamClient {
    client: reqwest::Client,
    latest_url: String,
    download_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LatestVersion {
    latest_version: String,
}

impl UpstreamClient {
    pub fn official() -> Result<Self, Error> {
        Self::new(
            LATEST_VERSION_URL.to_owned(),
            DESKTOP_DOWNLOAD_URL.to_owned(),
        )
    }

    pub fn new(latest_url: String, download_url: String) -> Result<Self, Error> {
        reqwest::Url::parse(&latest_url)?;
        reqwest::Url::parse(&download_url)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()?;
        Ok(Self {
            client,
            latest_url,
            download_url,
        })
    }

    pub async fn latest_version(&self) -> Result<String, Error> {
        let response = self
            .client
            .get(&self.latest_url)
            .send()
            .await?
            .error_for_status()?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !content_type.starts_with("application/json") {
            return Err("Factory version endpoint did not return application/json".into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > 64 * 1024)
        {
            return Err("Factory version response is too large".into());
        }
        let body = response.bytes().await?;
        if body.len() > 64 * 1024 {
            return Err("Factory version response is too large".into());
        }
        let payload: LatestVersion = serde_json::from_slice(&body)?;
        parse_version(&payload.latest_version)
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn download_url(&self, architecture: &str) -> Result<String, Error> {
        if architecture.is_empty()
            || !architecture
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(format!("invalid architecture: {architecture}").into());
        }
        let mut url = reqwest::Url::parse(&self.download_url)?;
        url.query_pairs_mut()
            .append_pair("platform", "darwin")
            .append_pair("architecture", architecture);
        Ok(url.into())
    }
}

pub fn parse_version(value: &str) -> Result<String, Error> {
    let suffix_start = value.find(['-', '+']);
    let (core, suffix) = suffix_start.map_or((value, None), |index| {
        (&value[..index], Some(&value[index..]))
    });
    let parts: Vec<_> = core.split('.').collect();
    let valid_core = parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    let valid_suffix = suffix.is_none_or(|suffix| {
        suffix.len() > 1
            && suffix[1..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    });
    if !valid_core || !valid_suffix {
        return Err(format!("invalid Factory version: {value}").into());
    }
    Ok(value.to_owned())
}

pub fn version_from_url(url: &reqwest::Url) -> Option<String> {
    let segments: Vec<_> = url.path_segments()?.collect();
    segments
        .windows(2)
        .find(|window| window[0] == "releases")
        .and_then(|window| parse_version(window[1]).ok())
}
