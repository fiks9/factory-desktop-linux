use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use std::time::Duration;

pub const LATEST_VERSION_URL: &str = "https://api.factory.ai/api/desktop/latest-version";
pub const OFFICIAL_DMG_ORIGIN: &str = "https://s3.us-west-1.amazonaws.com";
pub const OFFICIAL_DMG_PREFIX: &str = "/downloads.factory.ai/factory-desktop/releases";
pub const OFFICIAL_DMG_ARCHITECTURE: &str = "x64";

type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Clone)]
pub struct UpstreamClient {
    client: reqwest::Client,
    latest_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LatestVersion {
    latest_version: String,
}

impl UpstreamClient {
    pub fn official() -> Result<Self, Error> {
        Self::new(LATEST_VERSION_URL.to_owned())
    }

    pub fn new(latest_url: String) -> Result<Self, Error> {
        reqwest::Url::parse(&latest_url)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()?;
        Ok(Self { client, latest_url })
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

    pub fn download_client(
        &self,
        version: &str,
        architecture: &str,
    ) -> Result<reqwest::Client, Error> {
        let version = parse_version(version)?;
        let architecture = architecture.to_owned();
        exact_download_path(&version, &architecture)?;
        Ok(reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 8 {
                    return attempt.error("too many official Factory DMG redirects");
                }
                match validate_official_dmg_url(attempt.url().as_str(), &version, &architecture) {
                    Ok(_) => attempt.follow(),
                    Err(error) => attempt.error(error),
                }
            }))
            .build()?)
    }
}

fn exact_download_path(version: &str, architecture: &str) -> Result<String, Error> {
    let version = parse_version(version)?;
    if architecture != OFFICIAL_DMG_ARCHITECTURE {
        return Err(
            format!("unsupported official Factory DMG architecture: {architecture}").into(),
        );
    }
    Ok(format!(
        "{OFFICIAL_DMG_PREFIX}/{version}/darwin/{architecture}/Factory-{version}-{architecture}.dmg"
    ))
}

pub fn build_exact_download_url(version: &str, architecture: &str) -> Result<String, Error> {
    Ok(format!(
        "{OFFICIAL_DMG_ORIGIN}{}",
        exact_download_path(version, architecture)?
    ))
}

pub fn validate_official_dmg_url(
    value: &str,
    version: &str,
    architecture: &str,
) -> Result<String, Error> {
    let expected_path = exact_download_path(version, architecture)?;
    let candidate =
        reqwest::Url::parse(value).map_err(|_| "official Factory DMG URL is invalid")?;
    let expected_origin = reqwest::Url::parse(OFFICIAL_DMG_ORIGIN)?;
    let valid_authority = candidate.scheme() == "https"
        && candidate.host_str() == expected_origin.host_str()
        && candidate.port().is_none()
        && candidate.username().is_empty()
        && candidate.password().is_none();
    if !valid_authority {
        return Err("official Factory DMG URL must use the expected HTTPS host".into());
    }
    if candidate.path() != expected_path {
        return Err(format!(
            "official Factory DMG URL path does not match requested version {}",
            parse_version(version)?
        )
        .into());
    }
    if candidate.query().is_some() || candidate.fragment().is_some() {
        return Err("official Factory DMG URL must not contain query or fragment".into());
    }
    build_exact_download_url(version, architecture)
}

pub fn resolve_official_dmg_redirect(
    current_url: &str,
    location: &str,
    version: &str,
    architecture: &str,
) -> Result<String, Error> {
    let current = validate_official_dmg_url(current_url, version, architecture)?;
    if location.is_empty() {
        return Err("official Factory DMG redirect is missing".into());
    }
    let resolved = reqwest::Url::parse(&current)?.join(location)?;
    validate_official_dmg_url(resolved.as_str(), version, architecture)
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
