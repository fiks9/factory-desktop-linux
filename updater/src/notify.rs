use crate::state::{StateRecord, StateStore};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy)]
pub enum NotificationEvent {
    Ready,
    ManualAction,
    Installed,
    RolledBack,
    Rejected,
    RelaunchFailed,
}

impl NotificationEvent {
    fn key(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::ManualAction => "manual-action",
            Self::Installed => "installed",
            Self::RolledBack => "rolled-back",
            Self::Rejected => "rejected",
            Self::RelaunchFailed => "relaunch-failed",
        }
    }
}

pub trait NotificationBackend {
    fn send(&self, summary: &str, body: &str) -> Result<(), Error>;
}

pub struct DesktopNotifications;

impl NotificationBackend for DesktopNotifications {
    fn send(&self, summary: &str, body: &str) -> Result<(), Error> {
        if run_bounded(
            Command::new("notify-send").args(["--app-name", "Factory Desktop", summary, body]),
            Duration::from_secs(3),
        )
        .is_ok()
        {
            return Ok(());
        }
        let payload = format!(
            "{{'title': <'{}'>, 'body': <'{}'>}}",
            portal_escape(summary),
            portal_escape(body)
        );
        run_bounded(
            Command::new("gdbus").args([
                "call",
                "--session",
                "--dest",
                "org.freedesktop.portal.Desktop",
                "--object-path",
                "/org/freedesktop/portal/desktop",
                "--method",
                "org.freedesktop.portal.Notification.AddNotification",
                "org.factory.desktop",
                &payload,
            ]),
            Duration::from_secs(3),
        )
    }
}

pub fn notify_once(
    store: &StateStore,
    state: &mut StateRecord,
    event: NotificationEvent,
    summary: &str,
    body: &str,
    backend: &dyn NotificationBackend,
) -> Result<bool, Error> {
    let key = format!(
        "{}:{}:{}",
        event.key(),
        state.candidate_id.as_deref().unwrap_or("none"),
        state.version.as_deref().unwrap_or("none")
    );
    if state.notification_dedupe_key.as_deref() == Some(&key) {
        return Ok(false);
    }
    state.notification_dedupe_key = Some(key);
    store.save(state)?;
    let _ = backend.send(summary, body);
    Ok(true)
}

pub fn notify(summary: &str, body: &str) {
    let _ = DesktopNotifications.send(summary, body);
}

fn run_bounded(command: &mut Command, timeout: Duration) -> Result<(), Error> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return status
                .success()
                .then_some(())
                .ok_or_else(|| "notification backend rejected the request".into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("notification backend timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn portal_escape(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
}
