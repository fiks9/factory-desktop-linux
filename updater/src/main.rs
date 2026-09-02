use clap::{Parser, Subcommand, ValueEnum};
use factory_update_manager::approval::{
    load_approval_request, write_approval_request, ApprovalRequest, ApprovalStore,
    NodeApprovalInspector,
};
use factory_update_manager::builder::{BuildRequest, NodeBuilder, PackageFormat};
use factory_update_manager::cache::{candidate_id_for_digest, DmgCache};
use factory_update_manager::cleanup::cleanup;
use factory_update_manager::daemon::{blocks_new_candidate, read_check_interval_seconds};
use factory_update_manager::diagnose::diagnose;
use factory_update_manager::install::{install_validated, InstallOutcome};
use factory_update_manager::locks::UpdateLock;
use factory_update_manager::notify::{notify_once, DesktopNotifications, NotificationEvent};
use factory_update_manager::package_manager::{NativePackageManager, PackageManager};
use factory_update_manager::paths::Paths;
use factory_update_manager::polkit::{
    read_unattended, request_polkit_install, write_unattended_opt_in, Action, InstallRequestError,
};
use factory_update_manager::rollback::KnownGoodStore;
use factory_update_manager::state::{State, StateRecord, StateStore};
use factory_update_manager::upstream::{build_exact_download_url, UpstreamClient};
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
        version: Option<String>,
        #[arg(long, value_enum)]
        format: Option<FormatArg>,
    },
    Update {
        #[arg(long)]
        pid: u32,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
    Diagnose,
    ReconcileInstall,
    DiscardCandidate,
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
        Commands::CheckNow { version, format } => check_now(version, format.map(Into::into)),
        Commands::Update { pid } => update(&context, pid),
        Commands::Status { json: _ } => {
            with_user_state(|_, store, state| print_json(&status_view(store, &state)))
        }
        Commands::Diagnose => {
            with_user_state(|paths, _, state| print_json(&diagnose(paths, &state)))
        }
        Commands::ReconcileInstall => reconcile_install(),
        Commands::DiscardCandidate => discard_candidate(),
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

fn update(context: &Context, parent_pid: u32) -> Result<(), Error> {
    if parent_pid == 0 {
        return Err("--pid must identify the Factory Desktop process".into());
    }
    with_locked_user_state(|paths, store, mut state| {
        if state.install_requested
            || matches!(
                state.state,
                State::Checking
                    | State::Downloading
                    | State::Building
                    | State::Validating
                    | State::Installing
            )
        {
            return Err("an update operation is already active".into());
        }
        if state.state == State::UpdateAvailable {
            prepare_candidate(context, paths, store, &mut state)?;
        }
        if state.state != State::ReadyToInstall {
            return Err("no update is available; run a metadata check first".into());
        }
        request_install(store, &mut state)
    })?;
    wait_for_factory_exit(parent_pid)?;
    install_ready(context)?;
    relaunch_verified_install()
}

fn relaunch_verified_install() -> Result<(), Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let store = StateStore::new(paths.state_file());
    let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
    let mut state = store.load()?;
    if !matches!(
        state.state,
        State::Installed | State::RolledBack | State::ReadyToInstall
    ) {
        return Ok(());
    }
    let launcher = Path::new("/opt/Factory/factory-desktop-launcher");
    if state.state == State::ReadyToInstall && !launcher.is_file() {
        return Ok(());
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
    match command.spawn() {
        Ok(_) => {
            state.relaunch_pending = false;
            state.relaunch_error = None;
            store.save(&state)?;
            Ok(())
        }
        Err(error) => {
            state.relaunch_pending = false;
            state.relaunch_error = Some(format!(
                "update installed but Factory Desktop could not relaunch: {error}"
            ));
            store.save(&state)?;
            Err(error.into())
        }
    }
}
fn request_install(store: &StateStore, state: &mut StateRecord) -> Result<(), Error> {
    if state.install_requested {
        return Err("an installation request already exists".into());
    }
    state.install_requested = true;
    state.relaunch_pending = false;
    state.relaunch_error = None;
    state.updated_at = chrono::Utc::now();
    store.save(state)?;
    print_json(&status_view(store, state))
}

fn wait_for_factory_exit(parent_pid: u32) -> Result<(), Error> {
    let proc_root = if cfg!(debug_assertions) {
        std::env::var_os("FACTORY_TEST_PROC_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/proc"))
    } else {
        PathBuf::from("/proc")
    };
    let parent = proc_root.join(parent_pid.to_string());
    let timeout = Duration::from_secs(120);
    let poll_interval = Duration::from_millis(500);
    let mut elapsed = Duration::ZERO;
    while parent.exists() || app_is_running() {
        if elapsed >= timeout {
            return fail_active_operation("timed out waiting for Factory Desktop to exit");
        }
        thread::sleep(poll_interval);
        elapsed = elapsed.saturating_add(poll_interval);
    }
    Ok(())
}

fn fail_active_operation(message: &str) -> Result<(), Error> {
    with_locked_user_state(|_, store, mut state| {
        state.install_requested = false;
        state.relaunch_pending = false;
        transition(store, &mut state, State::Failed, message)?;
        Err(message.into())
    })
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
    let mut state = store.load()?;
    if factory_update_manager::daemon::recover_stale_state(&mut state, chrono::Utc::now()) {
        let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
        store.save(&state)?;
    }
    operation(&paths, &store, state)
}

fn with_locked_user_state<T>(
    operation: impl FnOnce(&Paths, &StateStore, StateRecord) -> Result<T, Error>,
) -> Result<T, Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let store = StateStore::new(paths.state_file());
    let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
    let mut state = store.load()?;
    if factory_update_manager::daemon::recover_stale_state(&mut state, chrono::Utc::now()) {
        store.save(&state)?;
    }
    operation(&paths, &store, state)
}
fn check_now(
    supplied_version: Option<String>,
    supplied_format: Option<PackageFormat>,
) -> Result<(), Error> {
    with_locked_user_state(|_, store, mut state| {
        if blocks_new_candidate(state.state) {
            return print_json(&status_view(store, &state));
        }
        let result = (|| -> Result<(), Error> {
            transition(
                store,
                &mut state,
                State::Checking,
                "checking Factory Desktop upstream metadata",
            )?;
            let manager = selected_manager(supplied_format)?;
            let version = match supplied_version {
                Some(version) => factory_update_manager::upstream::parse_version(&version)?,
                None => {
                    let upstream = UpstreamClient::official()?;
                    runtime()?.block_on(upstream.latest_version())?
                }
            };
            let installed = manager
                .installed_factory_version()?
                .ok_or("Factory Desktop is not installed through a supported package manager")?;
            if !is_newer_version(&version, &installed)? {
                clear_candidate_fields(&mut state);
                state.available_version = None;
                transition(
                    store,
                    &mut state,
                    State::Idle,
                    "already running the latest supported version",
                )?;
            } else {
                clear_candidate_fields(&mut state);
                state.available_version = Some(version);
                transition(
                    store,
                    &mut state,
                    State::UpdateAvailable,
                    "a newer Factory Desktop version is available",
                )?;
            }
            print_json(&status_view(store, &state))
        })();
        if let Err(error) = &result {
            transition(
                store,
                &mut state,
                State::Failed,
                &format!("metadata check failed: {error}"),
            )?;
        }
        result
    })
}

fn is_newer_version(candidate: &str, installed: &str) -> Result<bool, Error> {
    fn components(value: &str) -> Result<[u64; 3], Error> {
        let normalized = factory_update_manager::upstream::parse_version(value)?;
        let core = normalized.split(['-', '+']).next().unwrap_or_default();
        let mut result = [0_u64; 3];
        for (index, part) in core.split('.').enumerate() {
            result[index] = part.parse()?;
        }
        Ok(result)
    }
    Ok(components(candidate)? > components(installed)?)
}

fn clear_candidate_fields(state: &mut StateRecord) {
    state.candidate_id = None;
    state.version = None;
    state.package_path = None;
    state.package_sha256 = None;
    state.candidate_manifest = None;
    state.install_requested = false;
    state.manual_action_required = false;
    state.manual_command = None;
    state.approval_id = None;
    state.approval_expires_at = None;
    state.relaunch_pending = false;
    state.relaunch_error = None;
}

fn prepare_candidate(
    context: &Context,
    paths: &Paths,
    store: &StateStore,
    state: &mut StateRecord,
) -> Result<(), Error> {
    let version = state
        .available_version
        .clone()
        .ok_or("update metadata is missing the available version")?;
    clear_candidate_fields(state);
    let result = (|| -> Result<(), Error> {
        cleanup(paths, state)?;
        let manager = selected_manager(None)?;
        transition(
            store,
            state,
            State::Downloading,
            "acquiring immutable DMG candidate",
        )?;
        let cache = DmgCache::new(paths.downloads_dir());
        let dmg = if let Some(cached) = cache.lookup_accepted_version(&version)? {
            cached
        } else {
            let upstream = UpstreamClient::official()?;
            let url = build_exact_download_url(&version, "x64")?;
            let client = upstream.download_client(&version, "x64")?;
            runtime()?.block_on(factory_update_manager::download::download_official(
                &client, &url, &version, &cache,
            ))?
        };
        let candidate_id = candidate_id_for_digest(&dmg.sha256)?;
        let workspace = paths.workspaces_dir().join(&candidate_id);
        if workspace.exists() {
            fs::remove_dir_all(&workspace)?;
        }
        transition(
            store,
            state,
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
        cache.record_accepted_version(&version, &dmg.sha256)?;
        transition(
            store,
            state,
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
        state.available_version = None;
        state.candidate_id = Some(candidate_id);
        state.version = Some(candidate.version);
        state.package_path = Some(candidate.package_path);
        state.package_sha256 = Some(candidate.package_sha256);
        state.candidate_manifest = Some(candidate.manifest_path);
        transition(
            store,
            state,
            State::ReadyToInstall,
            "validated update is ready for authenticated installation",
        )?;
        notify_once(
            store,
            state,
            NotificationEvent::Ready,
            "Factory Desktop update ready",
            "Factory Desktop will install the validated update after it exits.",
            &DesktopNotifications,
        )?;
        Ok(())
    })();
    if let Err(error) = &result {
        let message = format!("candidate rejected: {error}");
        transition(store, state, State::Failed, &message)?;
        cleanup(paths, state)?;
        notify_once(
            store,
            state,
            NotificationEvent::Rejected,
            "Factory Desktop update rejected",
            &message,
            &DesktopNotifications,
        )?;
    }
    result
}

fn discard_candidate() -> Result<(), Error> {
    with_locked_user_state(|paths, store, mut state| {
        if state.state == State::Installing || state.install_requested {
            return Err("cannot discard a candidate while installation is active".into());
        }
        state.candidate_id = None;
        state.version = None;
        state.package_path = None;
        state.package_sha256 = None;
        state.candidate_manifest = None;
        state.manual_command = None;
        state.notification_dedupe_key = None;
        state.approval_id = None;
        state.approval_expires_at = None;
        state.relaunch_pending = false;
        state.relaunch_error = None;
        transition(store, &mut state, State::Idle, "update candidate discarded")?;
        cleanup(paths, &state)?;
        print_json(&status_view(store, &state))
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
        if state.state != State::ReadyToInstall {
            return Err("no validated update is waiting for installation".into());
        }
        if app_is_running() {
            state.message =
                Some("Factory Desktop is still running; installation remains pending exit".into());
            store.save(&state)?;
            return print_json(&status_view(store, &state));
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
            Err(error) => {
                let message = match error {
                    InstallRequestError::AuthorizationDenied => {
                        state.install_requested = false;
                        transition(
                            store,
                            &mut state,
                            State::ReadyToInstall,
                            "authentication was cancelled; the validated update remains ready",
                        )?;
                        "authentication was cancelled; retry Update to install the validated update"
                    }
                    other => {
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
                            &format!("privileged installation failed: {other}"),
                        )?;
                        "privileged installation failed; manual action is required"
                    }
                };
                notify_once(
                    store,
                    &mut state,
                    NotificationEvent::ManualAction,
                    "Factory Desktop update needs authentication",
                    message,
                    &DesktopNotifications,
                )?;
            }
        }
        let terminal = matches!(state.state, State::Installed | State::RolledBack);
        state.install_requested = false;
        state.relaunch_pending = false;
        state.updated_at = chrono::Utc::now();
        store.save(&state)?;
        if terminal {
            cleanup(paths, &state)?;
        }
        print_json(&status_view(store, &state))
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
    } else if factory_update_manager::daemon::recover_stale_state(&mut state, chrono::Utc::now()) {
        store.save(&state)?;
    }
    cleanup(paths, &state)?;
    Ok(state)
}

fn run_daemon(_context: &Context, once: bool) -> Result<(), Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let _daemon_lock = UpdateLock::acquire(&paths.daemon_lock_file())?;
    let interval = read_check_interval_seconds(&paths.config_dir.join("config.toml"))?;
    let mut state = recover_interrupted_install(&paths)?;

    loop {
        if !blocks_new_candidate(state.state) {
            if let Err(error) = check_now(None, None) {
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
    let proc_root = if cfg!(debug_assertions) {
        std::env::var_os("FACTORY_TEST_PROC_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/proc"))
    } else {
        PathBuf::from("/proc")
    };
    let Ok(entries) = fs::read_dir(proc_root) else {
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
        State::UpdateAvailable | State::ReadyToInstall => "available",
        State::Downloading | State::Building | State::Validating | State::Installing => {
            "downloading"
        }
        State::InstallFailedManualAction | State::Failed => "error",
    };
    serde_json::json!({
        "schemaVersion": 1,
        "kind": kind,
        "linuxState": linux_state,
        "message": state.message.as_deref().map(|value| sanitize_text(value, 512)),
        "updatedAt": state.updated_at,
        "availableVersion": (state.state == State::UpdateAvailable).then(|| state.available_version.clone()).flatten(),
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
