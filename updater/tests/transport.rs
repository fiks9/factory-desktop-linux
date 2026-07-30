use factory_update_manager::cache::DmgCache;
use factory_update_manager::download::download_official;
use factory_update_manager::upstream::{
    build_exact_download_url, parse_version, resolve_official_dmg_redirect,
    validate_official_dmg_url, UpstreamClient,
};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn serve(responses: Vec<(&'static str, &'static str)>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        for (status_and_headers, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status_and_headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    (format!("http://{address}"), handle)
}

#[test]
fn factory_versions_are_strict() {
    assert_eq!(parse_version("0.139.0").unwrap(), "0.139.0");
    assert_eq!(parse_version("1.2.3-beta.1").unwrap(), "1.2.3-beta.1");
    assert!(parse_version("latest").is_err());
    assert!(parse_version("1.2").is_err());
}

#[test]
fn exact_factory_0139_url_is_canonical_and_version_bound() {
    let expected = "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/releases/0.139.0/darwin/x64/Factory-0.139.0-x64.dmg";

    assert_eq!(
        build_exact_download_url("0.139.0", "x64").unwrap(),
        expected
    );
    assert_eq!(
        validate_official_dmg_url(expected, "0.139.0", "x64").unwrap(),
        expected
    );
    assert!(build_exact_download_url("latest", "x64").is_err());
    assert!(build_exact_download_url("0.139.0", "arm64").is_err());
}

#[test]
fn exact_factory_redirect_cannot_change_the_requested_version() {
    let current = build_exact_download_url("0.139.0", "x64").unwrap();
    let changed = build_exact_download_url("0.140.0", "x64").unwrap();

    let error = resolve_official_dmg_redirect(&current, &changed, "0.139.0", "x64").unwrap_err();

    assert!(error.to_string().contains("requested version"));
}

#[test]
fn exact_factory_url_rejects_invalid_transport_host_and_path() {
    let expected = build_exact_download_url("0.139.0", "x64").unwrap();
    for invalid in [
        expected.replace("https:", "http:"),
        expected.replace("s3.us-west-1.amazonaws.com", "downloads.example.com"),
        expected.replace("/downloads.factory.ai/", "/untrusted-bucket/"),
        expected.replace("Factory-0.139.0-x64.dmg", "Factory-0.140.0-x64.dmg"),
        format!("{expected}?redirect=1"),
    ] {
        assert!(
            validate_official_dmg_url(&invalid, "0.139.0", "x64").is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn accepted_version_index_reuses_only_verified_content_addressed_dmg() {
    let root = tempfile::tempdir().unwrap();
    let downloads = root.path().join("downloads");
    let source = root.path().join("Factory.dmg");
    std::fs::write(&source, b"accepted exact fixture").unwrap();
    let cache = DmgCache::new(downloads);
    let cached = cache.cache_pinned(&source).unwrap();

    assert!(cache.lookup_accepted_version("0.139.0").unwrap().is_none());

    cache
        .record_accepted_version("0.139.0", &cached.sha256)
        .unwrap();
    let reused = cache.lookup_accepted_version("0.139.0").unwrap().unwrap();

    assert_eq!(reused, cached);
}

#[test]
fn version_index_is_not_written_before_acceptance() {
    let root = tempfile::tempdir().unwrap();
    let downloads = root.path().join("downloads");
    let source = root.path().join("Factory.dmg");
    std::fs::write(&source, b"downloaded but not accepted").unwrap();
    let cache = DmgCache::new(downloads.clone());

    cache.cache_pinned(&source).unwrap();

    assert!(!downloads.join("version-index.json").exists());
    assert!(cache.lookup_accepted_version("0.139.0").unwrap().is_none());
}

#[tokio::test]
async fn latest_version_uses_documented_json_contract() {
    let (base, server) = serve(vec![(
        "200 OK\r\nContent-Type: application/json",
        r#"{"latestVersion":"0.139.0"}"#,
    )]);
    let upstream = UpstreamClient::new(format!("{base}/latest")).unwrap();

    assert_eq!(upstream.latest_version().await.unwrap(), "0.139.0");
    server.join().unwrap();
}

#[tokio::test]
async fn download_is_content_addressed_after_redirect_validation() {
    let (base, server) = serve(vec![
        (
            "302 Found\r\nLocation: /releases/0.139.0/darwin/x64/Factory.dmg",
            "",
        ),
        (
            "200 OK\r\nContent-Type: application/octet-stream",
            "dmg-payload",
        ),
    ]);
    let root = tempfile::tempdir().unwrap();
    let cache = DmgCache::new(root.path().join("downloads"));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .unwrap();

    let artifact = download_official(&client, &format!("{base}/desktop"), "0.139.0", &cache)
        .await
        .unwrap();

    assert_eq!(std::fs::read(&artifact.path).unwrap(), b"dmg-payload");
    assert!(artifact
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("Factory-"));
    server.join().unwrap();
}

#[tokio::test]
async fn redirect_version_mismatch_rejects_and_removes_partial() {
    let (base, server) = serve(vec![
        (
            "302 Found\r\nLocation: /releases/0.140.0/darwin/x64/Factory.dmg",
            "",
        ),
        ("200 OK", "wrong-release"),
    ]);
    let root = tempfile::tempdir().unwrap();
    let downloads = root.path().join("downloads");
    let cache = DmgCache::new(downloads.clone());
    let client = reqwest::Client::new();

    let error = download_official(&client, &format!("{base}/desktop"), "0.139.0", &cache)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("changed during download"));
    assert!(std::fs::read_dir(downloads).unwrap().next().is_none());
    server.join().unwrap();
}
