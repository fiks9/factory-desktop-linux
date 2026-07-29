use factory_update_manager::state::{State, StateRecord};
use std::fs;
use std::process::Command;

#[test]
fn rejected_candidate_is_recorded_as_failed() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let dmg = root.path().join("fixture.dmg");
    fs::create_dir(&home).unwrap();
    fs::write(&dmg, "not a real DMG").unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_factory-update-manager"))
        .env("HOME", &home)
        .arg("--builder-root")
        .arg(root.path().join("missing-builder"))
        .arg("check-now")
        .arg("--dmg")
        .arg(&dmg)
        .arg("--version")
        .arg("0.139.0")
        .arg("--format")
        .arg("deb")
        .status()
        .unwrap();

    assert!(!status.success());
    let state_path = home.join(".local/state/factory-update-manager/state.json");
    let state: StateRecord = serde_json::from_slice(&fs::read(state_path).unwrap()).unwrap();
    assert_eq!(state.state, State::Failed);
    assert!(state.message.unwrap().contains("candidate rejected"));
}
