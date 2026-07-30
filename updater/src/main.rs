use clap::{Parser, Subcommand, ValueEnum};
use factory_update_manager::after_exit::{run_after_exit, AfterExitBackend, AfterExitOptions};
use factory_update_manager::approval::{
    load_approval_request, write_approval_request, ApprovalRequest, ApprovalStore,
    NodeApprovalInspector,
};
use factory_update_manager::builder::{BuildRequest, NodeBuilder, PackageFormat};
use factory_update_manager::cache::DmgCache;
use factory_update_manager::cleanup::cleanup;
use factory_update_manager::daemon::{blocks_new_candidate, read_check_interval_seconds};
use factory_update_manager::diagnose::diagnose;
use factory_update_manager::install::{install_validated, InstallOutcome};
use factory_update_manager::locks::UpdateLock;
use factory_update_manager::notify::{notify_once, DesktopNotifications, NotificationEvent};
use factory_update_manager::package_manager::{NativePackageManager, PackageManager};
use factory_update_manager::paths::Paths;
use factory_update_manager::polkit::{
    read_unattended, request_polkit_install, write_unattended_opt_in, Action,
};
use factory_update_manager::rollback::KnownGoodStore;
use factory_update_manager::state::{State, StateRecord, StateStore};
use factory_update_manager::upstream::UpstreamClient;
use std::env::current_exe;
use std::ffi::OsString;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(Parser)]
#[command(
    name = "factory-update-manager",
    version,
    about = "Fail-closed Factory Desktop Linux update manager"
)]
struct Cli {
    #[arg(long, env = "FACTORY_UPDATE_BUILDER_ROOT")]
    builder_root: Option<PathBuf>,
    #[arg(long, env = "FACTORY_UPDATE_NODE", default_value = "node")]
    node: PathBuf,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    CheckNow {
        #[arg(long)]
        dmg: Option<PathBuf>,
        #[arg(long)]
        version: Option<String>,
        #[arg(long, value_enum)]
        format: Option<FormatArg>,
    },
    Rebuild {
        #[arg(long)]
        dmg: PathBuf,
        #[arg(long)]
        version: String,
        #[arg(long, value_enum)]
        format: Option<FormatArg>,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
    Diagnose,
    InstallReady,
    PrepareInstall {
        #[arg(long)]
        pid: u32,
        #[arg(long, hide = true)]
        no_spawn: bool,
    },
    #[command(hide = true)]
    AfterExit {
        #[arg(long)]
        pid: u32,
    },
    ReconcileInstall,
    SetupUnattended {
        #[arg(long)]
        acknowledge_authentication_required: bool,
    },
    InstallDeb {
        manifest: PathBuf,
    },
    InstallRpm {
        manifest: PathBuf,
    },
    ApproveCandidate {
        request: PathBuf,
    },
    InstallApprovedPackage {
        approval_id: String,
    },
    Rollback,
    Daemon {
        #[arg(long, hide = true)]
        once: bool,
    },
    Service,
}

#[derive(Clone, Copy, ValueEnum)]
enum FormatArg {
    Deb,
    Rpm,
}

impl From<FormatArg> for PackageFormat {
    fn from(value: FormatArg) -> Self {
        match value {
            FormatArg::Deb => Self::Deb,
            FormatArg::Rpm => Self::Rpm,
        }
    }
}

#[derive(Clone)]
struct Context {
    builder_root: Option<PathBuf>,
    node: PathBuf,
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("factory-update-manager: {error}");
        process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), Error> {
    let context = Context {
        builder_root: cli.builder_root,
        node: cli.node,
    };
    match cli.command {
        Commands::CheckNow {
            dmg,
            version,
            format,
        } => check_now(&context, dmg, version, format.map(Into::into)),
        Commands::Rebuild {
            dmg,
            version,
            format,
        } => check_now(&context, Some(dmg), Some(version), format.map(Into::into)),
        Commands::Status { json: _ } => {
            with_user_state(|_, store, state| print_json(&status_view(store, &state)))
        }
        Commands::Diagnose => {
            with_user_state(|paths, _, state| print_json(&diagnose(paths, &state)))
        }
        Commands::InstallReady => install_ready(&context),
        Commands::PrepareInstall { pid, no_spawn } => prepare_install(pid, no_spawn),
        Commands::AfterExit { pid } => after_exit(&context, pid),
        Commands::ReconcileInstall => reconcile_install(),
        Commands::SetupUnattended {
            acknowledge_authentication_required,
        } => setup_unattended(acknowledge_authentication_required),
        Commands::InstallDeb { manifest } => {
            privileged_install(&context, manifest, PackageFormat::Deb)
        }
        Commands::InstallRpm { manifest } => {
            privileged_install(&context, manifest, PackageFormat::Rpm)
        }
        Commands::ApproveCandidate { request } => privileged_approve_candidate(request),
        Commands::InstallApprovedPackage { approval_id } => {
            privileged_install_approved(&approval_id)
        }
        Commands::Rollback => privileged_rollback(),
        Commands::Daemon { once } => run_daemon(&context, once),
        Commands::Service => run_daemon(&context, false),
    }
}

fn setup_unattended(acknowledged: bool) -> Result<(), Error> {
    if !acknowledged {
        return Err("refusing unattended opt-in without --acknowledge-authentication-required; this architecture does not bypass polkit authentication".into());
    }
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    write_unattended_opt_in(&paths.config_dir.join("config.toml"))?;
    print_json(&serde_json::json!({
        "unattended": true,
        "passwordless": false,
        "approvalPolicy": "inactive-pending-privileged-live-review"
    }))
}

fn prepare_install(parent_pid: u32, no_spawn: bool) -> Result<(), Error> {
    with_locked_user_state(|_, store, mut state| {
        if state.state != State::ReadyPendingExit {
            return Err("no validated update is ready for after-exit installation".into());
        }
        if state.install_requested {
            return Err("an after-exit installation request already exists".into());
        }
        state.install_requested = true;
        state.relaunch_error = None;
        state.updated_at = chrono::Utc::now();
        store.save(&state)?;
        if !no_spawn {
            if let Err(error) = spawn_after_exit(parent_pid) {
                state.install_requested = false;
                state.relaunch_error = Some(format!("could not start after-exit helper: {error}"));
                store.save(&state)?;
                return Err(error);
            }
        }
        print_json(&status_view(store, &state))
    })
}

fn spawn_after_exit(parent_pid: u32) -> Result<(), Error> {
    let mut command = Command::new(current_exe()?);
    command
        .arg("after-exit")
        .arg("--pid")
        .arg(parent_pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()?;
    Ok(())
}

struct NativeAfterExitBackend<'a> {
    context: &'a Context,
    store: &'a StateStore,
}

impl AfterExitBackend for NativeAfterExitBackend<'_> {
    fn factory_running(&self, parent_pid: u32) -> bool {
        Path::new("/proc").join(parent_pid.to_string()).exists() || app_is_running()
    }

    fn wait(&self, duration: Duration) {
        thread::sleep(duration);
    }

    fn install_ready(&self) -> Result<State, factory_update_manager::after_exit::Error> {
        install_ready(self.context)?;
        Ok(self.store.load()?.state)
    }

    fn relaunch(&self, launcher: &Path) -> Result<(), factory_update_manager::after_exit::Error> {
        if launcher != Path::new("/opt/Factory/factory-desktop-launcher") {
            return Err("refusing to relaunch an unexpected executable".into());
        }
        let mut command = Command::new(launcher);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command.spawn()?;
        Ok(())
    }
}

fn after_exit(context: &Context, parent_pid: u32) -> Result<(), Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let store = StateStore::new(paths.state_file());
    let backend = NativeAfterExitBackend {
        context,
        store: &store,
    };
    let result = run_after_exit(
        &paths,
        &store,
        &AfterExitOptions {
            parent_pid,
            timeout: Duration::from_secs(120),
            poll_interval: Duration::from_millis(500),
            launcher: PathBuf::from("/opt/Factory/factory-desktop-launcher"),
        },
        &backend,
    );
    if result.is_err() {
        let _state_lock = UpdateLock::acquire(&paths.state_lock_file())?;
        let mut state = store.load()?;
        if matches!(state.state, State::Installed | State::RolledBack)
            && state.relaunch_error.is_some()
        {
            notify_once(
                &store,
                &mut state,
                NotificationEvent::RelaunchFailed,
                "Factory Desktop could not restart",
                "The update is verified. Start Factory Desktop manually and review updater status.",
                &DesktopNotifications,
            )?;
        }
    }
    result
}

fn reconcile_install() -> Result<(), Error> {
    with_locked_user_state(|_, store, mut state| {
        if state.state != State::InstallFailedManualAction {
            return Err("no manual installation is waiting for reconciliation".into());
        }
        let expected = state
            .version
            .clone()
            .ok_or("manual installation has no expected candidate version")?;
        let manager = NativePackageManager::detect()?;
        match manager.installed_version()? {
            Some(version) if version == expected => {
                state.manual_command = None;
                state.install_requested = false;
                transition(
                    store,
                    &mut state,
                    State::Installed,
                    "manual installation verified by the package manager",
                )?;
                print_json(&status_view(store, &state))
            }
            Some(version) => Err(format!(
                "manual installation verification failed: expected {expected}, got {version}"
            )
            .into()),
            None => {
                Err("manual installation verification failed: Factory Desktop is absent".into())
            }
        }
    })
}

fn with_user_state<T>(
    operation: impl FnOnce(&Paths, &StateStore, StateRecord) -> Result<T, Error>,
) -> Result<T, Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let store = StateStore::new(paths.state_file());
    operation(&paths, &store, store.load()?)
}

fn with_locked_user_state<T>(
    operation: impl FnOnce(&Paths, &StateStore, StateRecord) -> Result<T, Error>,
) -> Result<T, Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let store = StateStore::new(paths.state_file());
    let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
    let state = store.load()?;
    operation(&paths, &store, state)
}

fn check_now(
    context: &Context,
    pinned_dmg: Option<PathBuf>,
    supplied_version: Option<String>,
    supplied_format: Option<PackageFormat>,
) -> Result<(), Error> {
    with_locked_user_state(|paths, store, mut state| {
        if blocks_new_candidate(state.state) {
            return print_json(&state);
        }
        cleanup(paths, &state)?;
        state.candidate_id = None;
        state.version = None;
        state.package_path = None;
        state.package_sha256 = None;
        state.candidate_manifest = None;
        let result = (|| -> Result<(), Error> {
            transition(
                store,
                &mut state,
                State::Checking,
                "checking Factory Desktop upstream",
            )?;
            let manager = selected_manager(supplied_format)?;
            let version = match supplied_version {
                Some(version) => factory_update_manager::upstream::parse_version(&version)?,
                None => {
                    let upstream = UpstreamClient::official()?;
                    runtime()?.block_on(upstream.latest_version())?
                }
            };
            if pinned_dmg.is_none()
                && manager.installed_version()?.as_deref() == Some(version.as_str())
            {
                transition(
                    store,
                    &mut state,
                    State::Idle,
                    "already running the latest supported version",
                )?;
                return print_json(&state);
            }
            transition(
                store,
                &mut state,
                State::Downloading,
                "acquiring immutable DMG candidate",
            )?;
            let cache = DmgCache::new(paths.downloads_dir());
            let dmg = match pinned_dmg {
                Some(path) => cache.cache_pinned(&path)?,
                None => {
                    let upstream = UpstreamClient::official()?;
                    let url = upstream.download_url("x64")?;
                    runtime()?.block_on(factory_update_manager::download::download_official(
                        upstream.client(),
                        &url,
                        &version,
                        &cache,
                    ))?
                }
            };
            let candidate_id = format!("{}-{}", version, &dmg.sha256[..12]);
            let workspace = paths.workspaces_dir().join(&candidate_id);
            if workspace.exists() {
                fs::remove_dir_all(&workspace)?;
            }
            transition(
                store,
                &mut state,
                State::Building,
                "running fail-closed Node build pipeline",
            )?;
            let root = builder_root(context)?;
            let environment: Vec<(OsString, OsString)> = vec![
                (
                    "FACTORY_UPDATE_MANAGER_BINARY".into(),
                    current_exe()?.into_os_string(),
                ),
                (
                    "FACTORY_UPDATE_BUILDER_ROOT".into(),
                    root.clone().into_os_string(),
                ),
            ];
            let candidate = NodeBuilder::new(root, context.node.clone()).build(BuildRequest {
                candidate_id: candidate_id.clone(),
                version: version.clone(),
                dmg_path: dmg.path,
                workspace,
                downloads: paths.downloads_dir(),
                format: manager.format(),
                environment,
            })?;
            transition(
                store,
                &mut state,
                State::Validating,
                "package inspector accepted candidate",
            )?;
            if read_unattended(&paths.config_dir.join("config.toml"))? {
                let request = ApprovalRequest::from_candidate(&candidate)?;
                let request_path = candidate
                    .manifest_path
                    .parent()
                    .ok_or("candidate manifest has no workspace")?
                    .join("approval-request.json");
                write_approval_request(&request_path, &request)?;
            }
            state.candidate_id = Some(candidate_id);
            state.version = Some(candidate.version);
            state.package_path = Some(candidate.package_path);
            state.package_sha256 = Some(candidate.package_sha256);
            state.candidate_manifest = Some(candidate.manifest_path);
            transition(
                store,
                &mut state,
                State::ReadyPendingExit,
                "validated update is ready; install only after Factory Desktop exits",
            )?;
            notify_once(
                store,
                &mut state,
                NotificationEvent::Ready,
                "Factory Desktop update ready",
                "Restart Factory Desktop to install the validated update.",
                &DesktopNotifications,
            )?;
            print_json(&state)
        })();
        if let Err(error) = &result {
            let message = format!("candidate rejected: {error}");
            transition(store, &mut state, State::Failed, &message)?;
            cleanup(paths, &state)?;
            notify_once(
                store,
                &mut state,
                NotificationEvent::Rejected,
                "Factory Desktop update rejected",
                &message,
                &DesktopNotifications,
            )?;
        }
        result
    })
}

fn runtime() -> Result<tokio::runtime::Runtime, Error> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}

fn selected_manager(format: Option<PackageFormat>) -> Result<NativePackageManager, Error> {
    Ok(match format {
        Some(format) => NativePackageManager::for_format(format),
        None => NativePackageManager::detect()?,
    })
}

fn transition(
    store: &StateStore,
    state: &mut StateRecord,
    next: State,
    message: &str,
) -> Result<(), Error> {
    state.state = next;
    state.message = Some(message.to_owned());
    state.updated_at = chrono::Utc::now();
    state.manual_action_required = matches!(next, State::InstallFailedManualAction);
    store.save(state)?;
    Ok(())
}

fn install_ready(_context: &Context) -> Result<(), Error> {
    with_locked_user_state(|paths, store, mut state| {
        if state.state != State::ReadyPendingExit {
            return Err("no validated update is waiting for application exit".into());
        }
        if app_is_running() {
            state.message =
                Some("Factory Desktop is still running; installation remains pending exit".into());
            store.save(&state)?;
            return print_json(&state);
        }
        let manifest = state
            .candidate_manifest
            .clone()
            .ok_or("validated update manifest is missing")?;
        let format = factory_update_manager::builder::load_candidate_manifest(&manifest)?.format;
        let action = Action::for_install(
            format,
            read_unattended(&paths.config_dir.join("config.toml"))?,
        );
        transition(
            store,
            &mut state,
            State::Installing,
            "requesting one privileged installation",
        )?;
        state.manual_command = None;
        match request_polkit_install(action, &current_exe()?, &manifest) {
            Ok(stdout) => match parse_install_outcome(&stdout).as_deref() {
                Some("Installed") => {
                    transition(
                        store,
                        &mut state,
                        State::Installed,
                        "package manager accepted the validated update",
                    )?;
                    notify_once(
                        store,
                        &mut state,
                        NotificationEvent::Installed,
                        "Factory Desktop updated",
                        "The validated update was installed.",
                        &DesktopNotifications,
                    )?;
                }
                Some("RolledBack") => {
                    transition(
                        store,
                        &mut state,
                        State::RolledBack,
                        "installation failed and known-good rollback was installed",
                    )?;
                    notify_once(
                        store,
                        &mut state,
                        NotificationEvent::RolledBack,
                        "Factory Desktop rollback completed",
                        "The previous verified version was restored.",
                        &DesktopNotifications,
                    )?;
                }
                _ => {
                    state.manual_command = Some(format!(
                        "sudo {} {} {}",
                        current_exe()?.display(),
                        action.command(),
                        manifest.display()
                    ));
                    transition(
                        store,
                        &mut state,
                        State::InstallFailedManualAction,
                        "privileged helper did not report a successful install outcome",
                    )?;
                    notify_once(
                        store,
                        &mut state,
                        NotificationEvent::ManualAction,
                        "Factory Desktop update needs manual action",
                        "Open Factory Desktop updates to copy the validated command.",
                        &DesktopNotifications,
                    )?;
                }
            },
            Err(_) => {
                state.manual_command = Some(format!(
                    "sudo {} {} {}",
                    current_exe()?.display(),
                    action.command(),
                    manifest.display()
                ));
                transition(
                    store,
                    &mut state,
                    State::InstallFailedManualAction,
                    "polkit was unavailable or denied; copy the validated manual command",
                )?;
                notify_once(
                    store,
                    &mut state,
                    NotificationEvent::ManualAction,
                    "Factory Desktop update needs manual action",
                    "Open Factory Desktop updates to copy the validated command.",
                    &DesktopNotifications,
                )?;
            }
        }
        print_json(&state)
    })
}

fn approval_inspector() -> NodeApprovalInspector {
    NodeApprovalInspector::new(
        PathBuf::from("/usr/lib/factory-desktop/update-builder"),
        PathBuf::from("/usr/bin/node"),
    )
}

fn privileged_approve_candidate(request_path: PathBuf) -> Result<(), Error> {
    require_root()?;
    let _lock = UpdateLock::acquire(Path::new("/run/lock/factory-update-manager.lock"))?;
    let request = load_approval_request(&request_path)?;
    let record = ApprovalStore::new(PathBuf::from("/var/cache/factory-update-manager"), 0)
        .approve(
            &request,
            &approval_inspector(),
            chrono::Utc::now(),
            chrono::Duration::minutes(30),
        )?;
    print_json(&record)
}

fn privileged_install_approved(approval_id: &str) -> Result<(), Error> {
    require_root()?;
    let _lock = UpdateLock::acquire(Path::new("/run/lock/factory-update-manager.lock"))?;
    let manager = NativePackageManager::detect()?;
    let record = ApprovalStore::new(PathBuf::from("/var/cache/factory-update-manager"), 0)
        .install_approved(
            approval_id,
            &approval_inspector(),
            &manager,
            chrono::Utc::now(),
        )?;
    print_json(&serde_json::json!({
        "outcome": "Installed",
        "approvalId": record.approval_id,
        "version": record.version
    }))
}

fn parse_install_outcome(stdout: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    value.get("outcome")?.as_str().map(ToOwned::to_owned)
}

fn privileged_install(
    _context: &Context,
    manifest: PathBuf,
    format: PackageFormat,
) -> Result<(), Error> {
    require_root()?;
    let _lock = UpdateLock::acquire(Path::new("/run/lock/factory-update-manager.lock"))?;
    let outcome = install_validated(
        &manifest,
        Path::new("/usr/lib/factory-desktop/update-builder"),
        Path::new("/usr/bin/node"),
        Path::new("/var/cache/factory-update-manager/packages"),
        &NativePackageManager::for_format(format),
        &KnownGoodStore::new(
            PathBuf::from("/var/lib/factory-update-manager/known-good"),
            2,
        ),
    )?;
    print_json(&serde_json::json!({"outcome": format!("{outcome:?}")}))?;
    if outcome == InstallOutcome::InstallFailedManualAction {
        return Err(
            "installation failed and rollback was unavailable; manual action required".into(),
        );
    }
    Ok(())
}

fn privileged_rollback() -> Result<(), Error> {
    require_root()?;
    let _lock = UpdateLock::acquire(Path::new("/run/lock/factory-update-manager.lock"))?;
    let manager = NativePackageManager::detect()?;
    let known_good = KnownGoodStore::new(
        PathBuf::from("/var/lib/factory-update-manager/known-good"),
        2,
    );
    let previous = known_good
        .latest()?
        .ok_or("no retained known-good package is available for rollback")?;
    if previous.format != manager.format() {
        return Err("retained package format does not match this installation".into());
    }
    manager.install(&previous.package_path)?;
    match manager.installed_version()? {
        Some(version) if version == previous.version => {
            print_json(&serde_json::json!({"outcome": "RolledBack", "version": previous.version}))
        }
        Some(version) => Err(format!(
            "rollback verification failed: expected {}, got {version}",
            previous.version
        )
        .into()),
        None => Err("rollback verification failed: Factory Desktop is not installed".into()),
    }
}

fn recover_interrupted_install(paths: &Paths) -> Result<StateRecord, Error> {
    let store = StateStore::new(paths.state_file());
    let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
    let mut state = store.load()?;
    if state.state == State::Installing {
        transition(
            &store,
            &mut state,
            State::InstallFailedManualAction,
            "interrupted privileged installation requires explicit user action",
        )?;
    }
    cleanup(paths, &state)?;
    Ok(state)
}

fn run_daemon(context: &Context, once: bool) -> Result<(), Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let _daemon_lock = UpdateLock::acquire(&paths.daemon_lock_file())?;
    let interval = read_check_interval_seconds(&paths.config_dir.join("config.toml"))?;
    let mut state = recover_interrupted_install(&paths)?;

    loop {
        if !blocks_new_candidate(state.state) {
            if let Err(error) = check_now(context, None, None, None) {
                eprintln!("factory-update-manager daemon check failed: {error}");
            }
        }
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(interval));
        state = StateStore::new(paths.state_file()).load()?;
    }
}

fn require_root() -> Result<(), Error> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("this install command must run through polkit or as root".into());
    }
    Ok(())
}

fn builder_root(context: &Context) -> Result<PathBuf, Error> {
    let root = context.builder_root.clone().unwrap_or_else(|| {
        let installed = PathBuf::from("/usr/lib/factory-desktop/update-builder");
        if installed.is_dir() {
            installed
        } else {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    });
    if !root.join("scripts").join("build-app.js").is_file() {
        return Err(format!("update-builder is incomplete: {}", root.display()).into());
    }
    Ok(root)
}

fn app_is_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
            return false;
        }
        fs::read(entry.path().join("cmdline")).is_ok_and(|cmdline| {
            let cmdline = String::from_utf8_lossy(&cmdline);
            cmdline.contains("/opt/Factory/factory-desktop")
                || cmdline.contains("factory-desktop-launcher")
        })
    })
}

fn print_json(value: &impl serde::Serialize) -> Result<(), Error> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn status_view(store: &StateStore, state: &StateRecord) -> serde_json::Value {
    let linux_state = serde_json::to_value(state.state)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "failed".into());
    let kind = match state.state {
        State::Idle | State::Installed | State::RolledBack => "idle",
        State::Checking => "checking",
        State::Downloading | State::Building | State::Validating | State::Installing => {
            "downloading"
        }
        State::ReadyPendingExit => "available",
        State::InstallFailedManualAction | State::Failed => "error",
    };
    serde_json::json!({
        "schemaVersion": 1,
        "kind": kind,
        "linuxState": linux_state,
        "message": state.message.as_deref().map(|value| sanitize_text(value, 512)),
        "manualCommand": state.manual_command.as_deref().map(|value| sanitize_text(value, 4096)),
        "version": state.version,
        "packagePath": state.package_path,
        "packageSha256": state.package_sha256,
        "approvalId": state.approval_id,
        "approvalExpiresAt": state.approval_expires_at,
        "installRequested": state.install_requested,
        "notificationDedupeKey": state.notification_dedupe_key,
        "relaunchPending": state.relaunch_pending,
        "relaunchError": state.relaunch_error.as_deref().map(|value| sanitize_text(value, 512)),
        "state": state,
        "stateFile": store.path()
    })
}

fn sanitize_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, ' ' | '\t'))
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}
