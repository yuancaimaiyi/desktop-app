mod commands;
mod state;

use std::path::PathBuf;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path_resolver().app_data_dir().unwrap();
            std::fs::create_dir_all(&app_dir).ok();

            let config_path = app_dir.join("config.toml");
            let cfg = if config_path.exists() {
                hera_runner::config::AppConfig::load(&config_path).unwrap_or_default()
            } else {
                // First run, no saved preference yet: default GPU support to whatever
                // matches the actual hardware instead of always starting off.
                let mut cfg = hera_runner::config::AppConfig::default();
                cfg.runtime.gpu_enabled = hera_runner::gpu::detect_nvidia_gpu();
                cfg
            };

            // workflows/operators: in a bundled install they live in resource_dir/{workflows,operators}
            // (packed by tauri, see bundle.resources in tauri.conf.json). In dev mode
            // (HERA_WORKSPACE set, or operators/ found on disk) use the source tree.
            let workspace_root = resolve_workspace_root();
            std::env::set_current_dir(&workspace_root).ok();

            // In dev builds, `resource_dir()` can resolve to a stale copy that tauri-build
            // snapshotted into target/debug/{workflows,operators} on a previous compile —
            // it isn't re-synced when files are added/edited under the source workflows/
            // and operators/ dirs, so it silently shadows live edits. Debug builds always
            // have the real source tree available (workspace_root), so skip resource_dir
            // entirely there; only packaged release builds need it.
            let resource_dir = if cfg!(debug_assertions) { None } else { app.path_resolver().resource_dir() };

            // Prefer bundled resource_dir/workflows (production .deb/.AppImage/.exe),
            // fall back to workspace_root/workflows (dev / HERA_WORKSPACE).
            let workflows_dir = resource_dir
                .as_ref()
                .map(|r| r.join("workflows"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| workspace_root.join("workflows"));

            // Same precedence for operator manifests — without this, bundled installs have
            // no filesystem fallback when an operator isn't yet registered in the (empty,
            // freshly-created) local registry, and workflow config panels render blank.
            let operators_dir = resource_dir
                .as_ref()
                .map(|r| r.join("operators"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| workspace_root.join("operators"));

            let db_path = app_dir.join("registry.sqlite");
            let registry = hera_runner::registry::Registry::open(&db_path)
                .expect("failed to open registry");

            // Persist the absolute db path into config so the runner can open it too
            let mut cfg = cfg;
            cfg.registry.db_path = db_path.to_string_lossy().to_string();

            app.manage(state::AppState {
                config: std::sync::Mutex::new(cfg),
                config_path,
                operators_dir,
                workflows_dir,
                registry: std::sync::Mutex::new(registry),
                active_jobs: std::sync::Mutex::new(std::collections::HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_datasets,
            commands::scan_dir,
            commands::list_workflows,
            commands::get_workflow,
            commands::run_workflow,
            commands::cancel_job,
            commands::list_jobs,
            commands::job_artifacts,
            commands::find_reusable_panorama,
            commands::open_path,
            commands::resolve_tool,
            commands::detect_gpu,
            commands::get_config,
            commands::set_config,
            commands::operator_add,
            commands::operator_list,
            commands::operator_describe,
            commands::operator_remove,
            commands::job_provenance,
            commands::open_hera_session,
            commands::hera_file_info,
            commands::check_session_motion,
            commands::build_range_image,
            commands::build_range_image_windowed,
            commands::build_range_image_glim_windowed,
            commands::first_timestamp_host_ns,
            commands::read_file_base64,
            commands::read_text_file_opt,
            commands::solve_extrinsic,
            commands::project_overlay,
            commands::save_extrinsic,
            commands::load_trajectory,
            commands::interpolate_pose,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Walk up from the binary location to find the workspace root (contains `operators/`).
/// Falls back to the current working directory.
fn resolve_workspace_root() -> PathBuf {
    // Prefer HERA_WORKSPACE env var (set by tauri dev or launch scripts)
    if let Ok(ws) = std::env::var("HERA_WORKSPACE") {
        return PathBuf::from(ws);
    }
    // Walk up from current exe looking for operators/ directory
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for _ in 0..8 {
            if dir.join("operators").exists() {
                return dir;
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
