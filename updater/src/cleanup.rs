use crate::paths::Paths;
use crate::state::{State, StateRecord};
use std::fs;
use std::io;

pub fn cleanup(paths: &Paths, state: &StateRecord) -> io::Result<()> {
    for directory in [paths.downloads_dir(), paths.workspaces_dir()] {
        if !directory.exists() {
            continue;
        }
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().contains(".partial") {
                remove_entry(&entry.path())?;
            }
        }
    }
    if paths.workspaces_dir().exists() {
        let keep = matches!(
            state.state,
            State::ReadyToInstall | State::Installing | State::InstallFailedManualAction
        )
        .then_some(state.candidate_id.as_deref())
        .flatten();
        for entry in fs::read_dir(paths.workspaces_dir())? {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && Some(entry.file_name().to_string_lossy().as_ref()) != keep
            {
                remove_entry(&entry.path())?;
            }
        }
    }
    Ok(())
}

fn remove_entry(path: &std::path::Path) -> io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}
