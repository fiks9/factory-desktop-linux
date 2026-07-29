use fs4::fs_std::FileExt;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn held_locks() -> &'static Mutex<HashSet<PathBuf>> {
    static HELD_LOCKS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HELD_LOCKS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub struct UpdateLock {
    file: File,
    path: PathBuf,
}

impl UpdateLock {
    pub fn acquire(path: &Path) -> io::Result<Self> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "lock path has no parent directory",
            )
        })?;
        fs::create_dir_all(parent)?;
        let canonical = path.to_path_buf();
        let mut held = held_locks()
            .lock()
            .map_err(|_| io::Error::other("update lock registry is poisoned"))?;
        if !held.insert(canonical.clone()) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "update manager is already running",
            ));
        }
        drop(held);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path);
        let file = match file {
            Ok(file) => file,
            Err(error) => {
                let _ = held_locks().lock().map(|mut held| held.remove(&canonical));
                return Err(error);
            }
        };
        if let Err(error) = file.try_lock_exclusive() {
            let _ = held_locks().lock().map(|mut held| held.remove(&canonical));
            return Err(error);
        }
        Ok(Self {
            file,
            path: canonical,
        })
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
        let _ = held_locks().lock().map(|mut held| held.remove(&self.path));
    }
}
