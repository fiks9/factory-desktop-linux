use std::process::Command;

pub fn notify(summary: &str, body: &str) {
    let _ = Command::new("notify-send")
        .args(["--app-name", "Factory Desktop", summary, body])
        .status();
}
