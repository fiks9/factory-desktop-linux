use factory_update_manager::notify::{notify_once, NotificationBackend, NotificationEvent};
use factory_update_manager::state::{StateRecord, StateStore};
use std::cell::RefCell;

#[derive(Default)]
struct FakeNotifications {
    sent: RefCell<Vec<(String, String)>>,
}

impl NotificationBackend for FakeNotifications {
    fn send(&self, summary: &str, body: &str) -> Result<(), factory_update_manager::notify::Error> {
        self.sent.borrow_mut().push((summary.into(), body.into()));
        Ok(())
    }
}

#[test]
fn repeated_candidate_status_notification_is_persistently_deduplicated() {
    let root = tempfile::tempdir().unwrap();
    let store = StateStore::new(root.path().join("state.json"));
    let mut state = StateRecord {
        candidate_id: Some("candidate-140".into()),
        version: Some("0.140.0".into()),
        ..StateRecord::default()
    };
    store.save(&state).unwrap();
    let backend = FakeNotifications::default();

    assert!(notify_once(
        &store,
        &mut state,
        NotificationEvent::Ready,
        "Update ready",
        "Factory Desktop 0.140.0 is ready.",
        &backend,
    )
    .unwrap());
    assert!(!notify_once(
        &store,
        &mut state,
        NotificationEvent::Ready,
        "Update ready",
        "Factory Desktop 0.140.0 is ready.",
        &backend,
    )
    .unwrap());
    assert_eq!(backend.sent.borrow().len(), 1);
    assert_eq!(
        store.load().unwrap().notification_dedupe_key,
        Some("ready:candidate-140:0.140.0".into())
    );
}

#[test]
fn a_different_terminal_event_is_not_suppressed() {
    let root = tempfile::tempdir().unwrap();
    let store = StateStore::new(root.path().join("state.json"));
    let mut state = StateRecord {
        candidate_id: Some("candidate-140".into()),
        version: Some("0.140.0".into()),
        ..StateRecord::default()
    };
    store.save(&state).unwrap();
    let backend = FakeNotifications::default();

    notify_once(
        &store,
        &mut state,
        NotificationEvent::Installed,
        "Installed",
        "Installed 0.140.0",
        &backend,
    )
    .unwrap();
    notify_once(
        &store,
        &mut state,
        NotificationEvent::RolledBack,
        "Rolled back",
        "Restored previous version",
        &backend,
    )
    .unwrap();

    assert_eq!(backend.sent.borrow().len(), 2);
}
