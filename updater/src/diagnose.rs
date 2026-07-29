use crate::paths::Paths;
use crate::state::StateRecord;
use serde::Serialize;

#[derive(Serialize)]
pub struct Diagnosis<'a> {
    pub state: &'a StateRecord,
    pub state_file: String,
    pub downloads: String,
    pub workspaces: String,
    pub known_good: String,
}

pub fn diagnose<'a>(paths: &'a Paths, state: &'a StateRecord) -> Diagnosis<'a> {
    Diagnosis {
        state,
        state_file: paths.state_file().display().to_string(),
        downloads: paths.downloads_dir().display().to_string(),
        workspaces: paths.workspaces_dir().display().to_string(),
        known_good: paths.known_good_dir().display().to_string(),
    }
}
