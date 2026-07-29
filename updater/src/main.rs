use clap::{Parser, Subcommand, ValueEnum};
use factory_update_manager::builder::{BuildRequest, NodeBuilder, PackageFormat};
use factory_update_manager::cache::DmgCache;
use factory_update_manager::cleanup::cleanup;
use factory_update_manager::diagnose::diagnose;
use factory_update_manager::install::{install_validated, InstallOutcome};
use factory_update_manager::locks::UpdateLock;
use factory_update_manager::notify::notify;
use factory_update_manager::package_manager::{NativePackageManager, PackageManager};
use factory_update_manager::paths::Paths;
use factory_update_manager::polkit::{read_unattended, request_polkit_install, Action};
use factory_update_manager::rollback::KnownGoodStore;
use factory_update_manager::state::{State, StateRecord, StateStore};
use factory_update_manager::upstream::UpstreamClient;
use std::env::current_exe;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

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
    Status,
    Diagnose,
    InstallReady,
    InstallDeb {
        manifest: PathBuf,
    },
    InstallRpm {
        manifest: PathBuf,
    },
    InstallValidatedPackage {
        manifest: PathBuf,
    },
    Rollback,
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
        Commands::Status => with_user_state(|_, store, state| {
            print_json(&serde_json::json!({"state": state, "stateFile": store.path()}))
        }),
        Commands::Diagnose => {
            with_user_state(|paths, _, state| print_json(&diagnose(paths, &state)))
        }
        Commands::InstallReady => install_ready(&context),
        Commands::InstallDeb { manifest } => {
            privileged_install(&context, manifest, PackageFormat::Deb)
        }
        Commands::InstallRpm { manifest } => {
            privileged_install(&context, manifest, PackageFormat::Rpm)
        }
        Commands::InstallValidatedPackage { manifest } => privileged_install(
            &context,
            manifest.clone(),
            factory_update_manager::builder::load_candidate_manifest(&manifest)?.format,
        ),
        Commands::Rollback => privileged_rollback(),
        Commands::Service => service_recovery(),
    }
}

fn with_user_state<T>(
    operation: impl FnOnce(&Paths, &StateStore, StateRecord) -> Result<T, Error>,
) -> Result<T, Error> {
    let paths = Paths::resolve(None)?;
    paths.ensure_all()?;
    let store = StateStore::new(paths.state_file());
    operation(&paths, &store, store.load()?)
}

fn check_now(
    context: &Context,
    pinned_dmg: Option<PathBuf>,
    supplied_version: Option<String>,
    supplied_format: Option<PackageFormat>,
) -> Result<(), Error> {
    with_user_state(|paths, store, mut state| {
        let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
        if state.state == State::ReadyPendingExit {
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
            notify(
                "Factory Desktop update ready",
                "Restart Factory Desktop to install the validated update.",
            );
            print_json(&state)
        })();
        if let Err(error) = &result {
            let message = format!("candidate rejected: {error}");
            transition(store, &mut state, State::Failed, &message)?;
            cleanup(paths, &state)?;
            notify("Factory Desktop update rejected", &message);
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
    with_user_state(|paths, store, mut state| {
        let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
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
        match request_polkit_install(action, &current_exe()?, &manifest) {
            Ok(stdout) => match parse_install_outcome(&stdout).as_deref() {
                Some("Installed") => transition(
                    store,
                    &mut state,
                    State::Installed,
                    "package manager accepted the validated update",
                )?,
                Some("RolledBack") => transition(
                    store,
                    &mut state,
                    State::RolledBack,
                    "installation failed and known-good rollback was installed",
                )?,
                _ => transition(
                    store,
                    &mut state,
                    State::InstallFailedManualAction,
                    "privileged helper did not report a successful install outcome",
                )?,
            },
            Err(_) => transition(
                store,
                &mut state,
                State::InstallFailedManualAction,
                &format!(
                    "polkit was unavailable or denied; terminal fallback: sudo {} {} {}",
                    current_exe()?.display(),
                    action.command(),
                    manifest.display()
                ),
            )?,
        }
        print_json(&state)
    })
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

fn service_recovery() -> Result<(), Error> {
    with_user_state(|paths, store, mut state| {
        let _lock = UpdateLock::acquire(&paths.state_lock_file())?;
        if state.state == State::Installing {
            transition(
                store,
                &mut state,
                State::InstallFailedManualAction,
                "interrupted privileged installation requires explicit user action",
            )?;
        }
        Ok(())
    })
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
