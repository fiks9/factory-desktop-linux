use factory_update_manager::builder::{BuildRequest, NodeBuilder, PackageFormat};
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn write_node_fixture(root: &std::path::Path, inspector_ok: bool) -> std::path::PathBuf {
    let node = root.join("fake-node");
    let inspector_status = if inspector_ok { 0 } else { 1 };
    fs::write(
        &node,
        format!(
            r#"#!/usr/bin/env bash
set -euo pipefail
script="$1"
shift
case "$script" in
  */build-app.js)
    mkdir -p "$FACTORY_FIXTURE_APP"
    printf '{{"appDir":"%s"}}\n' "$FACTORY_FIXTURE_APP"
    ;;
  */package-deb.js)
    printf package > "$FACTORY_FIXTURE_PACKAGE"
    printf '{{"path":"%s","sha256":"ignored","bytes":7}}\n' "$FACTORY_FIXTURE_PACKAGE"
    ;;
  */inspect-package.js)
    printf '{{"format":"deb","valid":true}}\n'
    exit {inspector_status}
    ;;
esac
"#
        ),
    )
    .unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
    node
}

fn write_syntax_rejecting_node_fixture(root: &std::path::Path) -> std::path::PathBuf {
    let node = root.join("fake-node-syntax-rejection");
    fs::write(
        &node,
        r#"#!/usr/bin/env bash
set -euo pipefail
script="$1"
shift
case "$script" in
  */build-app.js)
    mkdir -p "$FACTORY_FIXTURE_APP"
    printf '{"appDir":"%s"}\n' "$FACTORY_FIXTURE_APP"
    ;;
  */package-deb.js)
    printf package > "$FACTORY_FIXTURE_PACKAGE"
    printf '{"path":"%s","sha256":"ignored","bytes":7}\n' "$FACTORY_FIXTURE_PACKAGE"
    ;;
  */inspect-package.js)
    printf '%s\n' 'Package inspection failed: Bundle JavaScript syntax validation failed' >&2
    exit 1
    ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
    node
}

#[test]
fn accepted_candidate_has_a_verified_manifest() {
    let root = tempfile::tempdir().unwrap();
    let scripts = root.path().join("scripts");
    fs::create_dir(&scripts).unwrap();
    for file in ["build-app.js", "package-deb.js", "inspect-package.js"] {
        fs::write(scripts.join(file), "fixture").unwrap();
    }
    let workspace = root.path().join("workspace");
    let app = workspace.join("build").join("app");
    let package = workspace.join("artifacts").join("candidate.deb");
    let dmg = root.path().join("source.dmg");
    fs::write(&dmg, "fixture").unwrap();
    let node = write_node_fixture(root.path(), true);
    let builder = NodeBuilder::new(root.path().to_path_buf(), node);

    let candidate = builder
        .build(BuildRequest {
            candidate_id: "candidate-139".into(),
            version: "0.139.0".into(),
            dmg_path: dmg,
            workspace,
            downloads: root.path().join("downloads"),
            format: PackageFormat::Deb,
            environment: vec![
                ("FACTORY_FIXTURE_APP".into(), app.into_os_string()),
                ("FACTORY_FIXTURE_PACKAGE".into(), package.into_os_string()),
            ],
        })
        .unwrap();

    assert_eq!(candidate.version, "0.139.0");
    assert_eq!(candidate.format, PackageFormat::Deb);
    assert_eq!(candidate.package_sha256.len(), 64);
    assert!(candidate.manifest_path.is_file());
}

#[test]
fn inspector_failure_rejects_candidate_and_removes_workspace() {
    let root = tempfile::tempdir().unwrap();
    let scripts = root.path().join("scripts");
    fs::create_dir(&scripts).unwrap();
    for file in ["build-app.js", "package-deb.js", "inspect-package.js"] {
        fs::write(scripts.join(file), "fixture").unwrap();
    }
    let workspace = root.path().join("workspace");
    let dmg = root.path().join("source.dmg");
    fs::write(&dmg, "fixture").unwrap();
    let node = write_node_fixture(root.path(), false);
    let builder = NodeBuilder::new(root.path().to_path_buf(), node);

    let result = builder.build(BuildRequest {
        candidate_id: "candidate-bad".into(),
        version: "0.139.0".into(),
        dmg_path: dmg,
        workspace: workspace.clone(),
        downloads: root.path().join("downloads"),
        format: PackageFormat::Deb,
        environment: vec![
            (
                "FACTORY_FIXTURE_APP".into(),
                workspace.join("build").join("app").into_os_string(),
            ),
            (
                "FACTORY_FIXTURE_PACKAGE".into(),
                workspace.join("artifacts").join("bad.deb").into_os_string(),
            ),
        ],
    });

    assert!(result.is_err());
    assert!(!workspace.exists());
}

#[test]
fn syntax_invalid_package_is_not_promoted_to_a_candidate() {
    let root = tempfile::tempdir().unwrap();
    let scripts = root.path().join("scripts");
    fs::create_dir(&scripts).unwrap();
    for file in ["build-app.js", "package-deb.js", "inspect-package.js"] {
        fs::write(scripts.join(file), "fixture").unwrap();
    }
    let workspace = root.path().join("workspace");
    let dmg = root.path().join("source.dmg");
    fs::write(&dmg, "fixture").unwrap();
    let node = write_syntax_rejecting_node_fixture(root.path());
    let builder = NodeBuilder::new(root.path().to_path_buf(), node);

    let result = builder.build(BuildRequest {
        candidate_id: "candidate-invalid-syntax".into(),
        version: "0.139.0".into(),
        dmg_path: dmg,
        workspace: workspace.clone(),
        downloads: root.path().join("downloads"),
        format: PackageFormat::Deb,
        environment: vec![
            (
                "FACTORY_FIXTURE_APP".into(),
                workspace.join("build").join("app").into_os_string(),
            ),
            (
                "FACTORY_FIXTURE_PACKAGE".into(),
                workspace
                    .join("artifacts")
                    .join("invalid.deb")
                    .into_os_string(),
            ),
        ],
    });

    assert!(result
        .unwrap_err()
        .to_string()
        .contains("JavaScript syntax validation failed"));
    assert!(!workspace.exists());
}
