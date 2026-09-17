use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;
use hera_runner::config::AppConfig;
use hera_runner::registry::{ArtifactRow, DatasetRow, JobRow, OperatorSummaryRow, StepProvenanceRow};
use hera_runner::workflow::Workflow;
use hera_runner::{JobEvent, JobRunner};

// ── Datasets ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_datasets(state: State<AppState>) -> Result<Vec<DatasetRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .list_datasets()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scan_dir(path: String, state: State<AppState>) -> Result<usize, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    let reg = state.registry.lock().unwrap();
    let mut count = 0;
    for entry in walkdir::WalkDir::new(&p).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let file_type = match ext {
                "hera" => "hera",
                "db3" => "db3",
                "bag" => "bag",
                "ply" | "pcd" | "csv" => "pointcloud",
                _ => continue,
            };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            reg.upsert_dataset(
                &entry.path().to_string_lossy(),
                file_type,
                size,
                None,
            )
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

// ── Workflows ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_workflows(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let dir = &state.workflows_dir;
    let mut result = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(wf) = Workflow::load(&entry.path()) {
                    result.push(serde_json::json!({
                        "id": wf.id,
                        "name": wf.name,
                        "description": wf.description,
                        "input": wf.input,
                    }));
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_workflow(id: String, state: State<AppState>) -> Result<serde_json::Value, String> {
    let path = state.workflows_dir.join(format!("{}.json", id));
    let wf = Workflow::load(&path).map_err(|e| e.to_string())?;

    let reg = state.registry.lock().unwrap();

    let mut nodes_with_params: Vec<serde_json::Value> = Vec::new();
    for node in &wf.nodes {
        // Gather available versions from registry
        let available_versions: Vec<String> = reg
            .operator_list()
            .unwrap_or_default()
            .into_iter()
            .find(|op| op.id == node.operator)
            .map(|op| op.versions.into_iter().map(|v| v.version).collect())
            .unwrap_or_default();

        let pinned_version = node.version.clone().unwrap_or_else(|| "latest".to_string());

        // Resolve params_schema: 磁盘 operator.json 优先（可编辑字段的唯一权威源），
        // registry 只作为回落——registry 里保存的 manifest 是注册时刻从 docker --describe
        // 抓的快照，不会随源代码更新；开发时改 operator.json 想立刻在 UI 生效必须走磁盘。
        // 这一逻辑与 dag.rs::load_operator_for_step 一致。
        let (params_schema, param_schema_legacy, gpu) = {
            let op_path = state.operators_dir.join(&node.operator).join("operator.json");
            let disk_manifest: Option<serde_json::Value> = std::fs::read_to_string(&op_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());

            let effective = disk_manifest.clone().or_else(|| {
                reg.resolve_operator(&node.operator, &pinned_version)
                    .ok()
                    .flatten()
                    .and_then(|(mj, ..)| serde_json::from_str::<serde_json::Value>(&mj).ok())
            });

            if let Some(manifest) = effective {
                let schema = manifest.get("params_schema").cloned();
                let gpu = manifest.get("gpu").and_then(|v| v.as_str()).map(str::to_string);
                // 老版 UI 兼容：param_schema 数组
                let legacy = hera_runner::manifest::Operator::load(&op_path)
                    .map(|op| serde_json::to_value(&op.params).unwrap_or(serde_json::Value::Null))
                    .unwrap_or(serde_json::Value::Null);
                (schema, legacy, gpu)
            } else {
                (None, serde_json::Value::Null, None)
            }
        };

        nodes_with_params.push(serde_json::json!({
            "id": node.id,
            "operator": node.operator,
            "version": pinned_version,
            "available_versions": available_versions,
            "params": node.params,
            "params_schema": params_schema,
            "param_schema": param_schema_legacy,
            "gpu": gpu,
        }));
    }

    Ok(serde_json::json!({
        "id": wf.id,
        "name": wf.name,
        "description": wf.description,
        "input": wf.input,
        "nodes": nodes_with_params,
        "edges": wf.edges,
        "workflow_input_to": wf.workflow_input_to,
    }))
}

// ── Job execution ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn run_workflow(
    workflow_id: String,
    input_path: String,
    param_overrides: HashMap<String, HashMap<String, serde_json::Value>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let wf_path = state
        .workflows_dir
        .join(format!("{}.json", workflow_id));
    let wf = Workflow::load(&wf_path).map_err(|e| e.to_string())?;

    let config = state.config.lock().unwrap().clone();
    let operators_dir = state.operators_dir.clone();

    let runner = JobRunner::new(config.clone(), operators_dir, &workflow_id);
    let job_id = runner.job_id.clone();

    {
        let reg = state.registry.lock().unwrap();
        reg.start_job(
            &job_id,
            &workflow_id,
            &input_path,
            &serde_json::to_string(&param_overrides).unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
    }

    let app2 = app.clone();
    let jid2 = job_id.clone();
    let reg_path = config.registry.db_path.clone();

    let handle = tokio::spawn(async move {
        let input = PathBuf::from(&input_path);
        let mut rx = runner.run_workflow(&wf, &input, &param_overrides).await;
        let mut success = false;

        while let Some(event) = rx.recv().await {
            let payload = match &event {
                JobEvent::StepStart { step, image } => serde_json::json!({
                    "type": "step_start", "job": jid2, "step": step, "image": image
                }),
                JobEvent::Log { step, text, is_stderr } => serde_json::json!({
                    "type": "log", "job": jid2, "step": step, "text": text, "is_stderr": is_stderr
                }),
                JobEvent::StepComplete { step } => serde_json::json!({
                    "type": "step_complete", "job": jid2, "step": step
                }),
                JobEvent::StepFailed { step, exit_code, reason, log_path } => serde_json::json!({
                    "type": "step_failed", "job": jid2, "step": step,
                    "exit_code": exit_code, "reason": reason, "log_path": log_path,
                }),
                JobEvent::JobComplete { artifacts } => {
                    success = true;
                    serde_json::json!({
                        "type": "job_complete", "job": jid2,
                        "artifacts": artifacts.iter().map(|a| serde_json::json!({
                            "id": a.id, "step": a.step, "output_id": a.output_id, "host_path": a.host_path
                        })).collect::<Vec<_>>()
                    })
                }
                JobEvent::JobFailed { step, reason } => serde_json::json!({
                    "type": "job_failed", "job": jid2, "step": step, "reason": reason
                }),
            };

            // Persist artifacts
            if let JobEvent::JobComplete { artifacts } = &event {
                if let Ok(reg) = hera_runner::registry::Registry::open(Path::new(&reg_path)) {
                    for a in artifacts {
                        let _ = reg.insert_artifact(&a.id, &jid2, &a.step, &a.output_id, &a.host_path);
                    }
                }
            }

            let _ = app2.emit_all("job-event", &payload);
        }

        if let Ok(reg) = hera_runner::registry::Registry::open(Path::new(&reg_path)) {
            let _ = reg.finish_job(&jid2, success);
        }
    });

    state.active_jobs.lock().unwrap().insert(job_id.clone(), handle);
    Ok(job_id)
}

/// Aborting the Rust task alone does not stop the container it was waiting on
/// (`tokio::process::Command` here has no `kill_on_drop`) — without also
/// `docker stop`-ing it by name (`hera-<job_id>-<step_id>`, see `dag.rs`), a
/// cancelled step's container keeps running orphaned. Runs the stop best-effort
/// and doesn't fail the command if none are found, since by the time the user
/// clicks cancel the container may have already exited on its own.
#[tauri::command]
pub fn cancel_job(job_id: String, state: State<AppState>) -> Result<(), String> {
    let handle = state.active_jobs.lock().unwrap().remove(&job_id);
    if let Some(handle) = handle {
        handle.abort();
    }

    let container_bin = state.config.lock().unwrap().runtime.container.clone();
    let prefix = format!("hera-{}-", job_id);
    if let Ok(out) = std::process::Command::new(&container_bin)
        .args(["ps", "-q", "--filter", &format!("name={}", prefix)])
        .output()
    {
        for id in String::from_utf8_lossy(&out.stdout).lines() {
            let id = id.trim();
            if !id.is_empty() {
                let _ = std::process::Command::new(&container_bin).args(["stop", id]).output();
            }
        }
    }
    Ok(())
}

// ── Job history ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_jobs(state: State<AppState>) -> Result<Vec<JobRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .list_jobs()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_artifacts(job_id: String, state: State<AppState>) -> Result<Vec<ArtifactRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .job_artifacts(&job_id)
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct StepLogInfo {
    pub step: String,
    pub log_path: String,
    pub exists: bool,
    pub size_bytes: u64,
}

/// 枚举一个 job 下每个 step 的 step.log。
/// 路径约定：<output_dir>/<job_id>/<step_id>/step.log（见 runner/dag.rs）
/// 无论成功/失败都会返回：成功场景下也能回看 step 的完整日志。
#[tauri::command]
pub fn job_step_logs(job_id: String, state: State<AppState>) -> Result<Vec<StepLogInfo>, String> {
    let output_dir = state.config.lock().unwrap().output_dir();
    let job_dir = output_dir.join(&job_id);
    if !job_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&job_dir).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let step_id = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let log_path = p.join("step.log");
        let (exists, size) = match std::fs::metadata(&log_path) {
            Ok(m) => (true, m.len()),
            Err(_) => (false, 0),
        };
        out.push(StepLogInfo {
            step: step_id,
            log_path: log_path.to_string_lossy().to_string(),
            exists,
            size_bytes: size,
        });
    }
    // 按 step 名排序，UI 稳定
    out.sort_by(|a, b| a.step.cmp(&b.step));
    Ok(out)
}

/// 读一个日志文件的最后 N 字节（默认 512 KiB）。
/// 大日志防 OOM——UI 用于内嵌预览；「打开日志」按钮走 openPath 用外部编辑器看全文。
#[tauri::command]
pub fn read_log_tail(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let cap = max_bytes.unwrap_or(512 * 1024);
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(cap);
    if start > 0 {
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    // 从截断处的第一个换行后开始，避免半行乱码
    let s = String::from_utf8_lossy(&buf).to_string();
    let s = if start > 0 {
        match s.find('\n') {
            Some(i) => s[i + 1..].to_string(),
            None => s,
        }
    } else {
        s
    };
    Ok(s)
}

/// Find the newest reusable panorama job for the exact same input path.
/// A cache hit is accepted only when the job succeeded, both the stitched
/// video and extracted frame still exist and are non-empty, and the source
/// .insv has not been modified since the job completed.
#[tauri::command]
pub fn find_reusable_panorama(
    input_path: String,
    state: State<AppState>,
) -> Result<Option<Vec<ArtifactRow>>, String> {
    let input = PathBuf::from(&input_path);
    let input_modified = input
        .metadata()
        .and_then(|m| m.modified())
        .map_err(|e| format!("无法读取 INSV 修改时间：{e}"))?;
    let reg = state.registry.lock().unwrap();
    let jobs = reg.list_jobs().map_err(|e| e.to_string())?;
    for job in jobs {
        if job.workflow_id != "calib_panorama_frame"
            || job.input_path != input_path
            || job.status != "success"
        {
            continue;
        }
        let artifacts = reg.job_artifacts(&job.id).map_err(|e| e.to_string())?;
        let valid = |output_id: &str| {
            artifacts.iter().any(|a| {
                if a.output_id != output_id {
                    return false;
                }
                std::fs::metadata(&a.host_path)
                    .map(|m| {
                        m.is_file()
                            && m.len() > 0
                            && m.modified().map(|t| t >= input_modified).unwrap_or(false)
                    })
                    .unwrap_or(false)
            })
        };
        if valid("panorama") && valid("frame") {
            return Ok(Some(artifacts));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn job_provenance(
    job_id: String,
    state: State<AppState>,
) -> Result<Vec<StepProvenanceRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .job_provenance(&job_id)
        .map_err(|e| e.to_string())
}

// ── Hera session ─────────────────────────────────────────────────────────────

/// Open a .hera file: stat it, find the adjacent .insv and .session.json,
/// read the session.json content, upsert the hera file into the dataset registry.
#[tauri::command]
pub fn open_hera_session(
    path: String,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }

    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let dir = p.parent().unwrap_or_else(|| Path::new("."));

    let hera_size = p.metadata().map(|m| m.len()).unwrap_or(0);

    let insv_path = dir.join(format!("{}.insv", stem));
    let insv_size: Option<u64> = insv_path.metadata().ok().map(|m| m.len());
    let insv_path_str: Option<String> = if insv_path.exists() {
        Some(insv_path.to_string_lossy().to_string())
    } else {
        None
    };

    let session_json_path = dir.join(format!("{}.session.json", stem));
    let session_json: Option<String> = std::fs::read_to_string(&session_json_path).ok();
    let session_json_size: Option<u64> = session_json_path.metadata().ok().map(|m| m.len());

    {
        let reg = state.registry.lock().unwrap();
        let _ = reg.upsert_dataset(&path, "hera", hera_size, None);
    }

    Ok(serde_json::json!({
        "path": path,
        "stem": stem,
        "hera_size": hera_size,
        "insv_path": insv_path_str,
        "insv_size": insv_size,
        "session_json": session_json,
        "session_json_size": session_json_size,
    }))
}

/// Parse the `.hera` binary header (magic/version, timestamp range, per-device
/// message/byte counts, and the V4 `extra_info` JSON blob). Header-only read —
/// packet data is never touched, so this is cheap regardless of file size.
#[tauri::command]
pub fn hera_file_info(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(&path);
    let header = hera_runner::hera_format::read_header(&p).map_err(|e| e.to_string())?;
    let duration_s = (header.timestamp_end_ns.saturating_sub(header.timestamp_start_ns)) as f64 / 1e9;
    Ok(serde_json::json!({
        "version": header.version,
        "timestamp_start_ns": header.timestamp_start_ns,
        "timestamp_end_ns": header.timestamp_end_ns,
        "duration_s": duration_s,
        "devices": header.devices,
        "extra_info": header.extra_info,
    }))
}

/// Extract the IMU stream via the host `hera-storage-extract-mid360` binary and
/// judge static vs. motion from per-axis gyro std (see `hera_runner::motion` for
/// why magnitude alone is not a valid test). This is only a suggestion — the UI
/// must still let the user override it, never auto-branch without confirmation.
#[tauri::command]
pub fn check_session_motion(
    hera_path: String,
    threshold: Option<f64>,
    state: State<AppState>,
) -> Result<hera_runner::MotionCheckResult, String> {
    let p = PathBuf::from(&hera_path);
    if !p.exists() {
        return Err(format!("file not found: {}", hera_path));
    }

    let tool_path = {
        let cfg = state.config.lock().unwrap();
        cfg.data.storage_extract_mid360_path.clone()
    }
    .ok_or_else(|| "未配置 hera-storage-extract-mid360 路径，请在设置 → 外部工具中填写".to_string())?;
    let tool_path = PathBuf::from(tool_path);
    if !tool_path.is_file() {
        return Err(format!(
            "hera-storage-extract-mid360 未找到：{}",
            tool_path.display()
        ));
    }

    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("session");
    let out_csv = std::env::temp_dir().join(format!(
        "hera-calib-{}-{}.imu.csv",
        stem,
        uuid::Uuid::new_v4()
    ));

    hera_runner::extract_imu_csv(&tool_path, &p, &out_csv).map_err(|e| e.to_string())?;
    let result = hera_runner::check_motion(
        &out_csv,
        threshold.unwrap_or(hera_runner::DEFAULT_REST_STD_THRESHOLD),
    );
    let _ = std::fs::remove_file(&out_csv);
    result.map_err(|e| e.to_string())
}

/// Bins a point cloud (.csv from storage-extract-mid360, or .ply from
/// glim-export-pcd) into an azimuth/elevation range image for the right-hand
/// selection panel — see `hera_runner::rangeimage` for the binning math and why
/// magnitude/nearest-point-per-bin was chosen. Recomputed on demand rather than
/// cached: it only runs once per session when the user opens the point-select
/// stage, not on every interaction.
#[tauri::command]
pub fn build_range_image(
    pointcloud_path: String,
    az_bins: u32,
    el_bins: u32,
    invert_elevation: bool,
    frame_pose: Option<hera_runner::Pose>,
) -> Result<hera_runner::RangeImageResult, String> {
    let p = PathBuf::from(&pointcloud_path);
    if !p.exists() {
        return Err(format!("file not found: {}", pointcloud_path));
    }
    let mut points = hera_runner::load_points_xyz(&p).map_err(|e| e.to_string())?;
    // Motion scene (§7): re-express the aggregated GLIM-world-frame map as "what
    // the LiDAR saw" at the scrubbed timeline pose, so the same binning code
    // works for both static (frame_pose=None, points already LiDAR-frame) and
    // motion (frame_pose=Some, points are world-frame) point clouds.
    if let Some(pose) = frame_pose {
        points = hera_runner::world_to_frame(&points, &pose);
    }
    let mut result = hera_runner::build_range_image(&points, az_bins, el_bins, invert_elevation).map_err(|e| e.to_string())?;
    result.source = if frame_pose.is_some() { "glim_whole_map" } else { "pointcloud" }.to_string();
    Ok(result)
}

/// Right-panel "raw single-frame" source (as opposed to the GLIM aggregated
/// map): a time-windowed slice straight out of the un-reconstructed
/// `storage-extract-mid360 --points` CSV — no SLAM aggregation, so no
/// whole-session drift/noise, but only whatever the LiDAR actually captured in
/// that narrow window (sparser). See `hera_runner::rangeimage::load_csv_xyz_windowed`.
#[tauri::command]
pub fn build_range_image_windowed(
    raw_points_path: String,
    t_center_sec: f64,
    window_sec: f64,
    az_bins: u32,
    el_bins: u32,
    invert_elevation: bool,
) -> Result<hera_runner::RangeImageResult, String> {
    let p = PathBuf::from(&raw_points_path);
    if !p.exists() {
        return Err(format!("file not found: {}", raw_points_path));
    }
    let points = hera_runner::load_csv_xyz_windowed(&p, t_center_sec, window_sec).map_err(|e| e.to_string())?;
    let mut result = hera_runner::build_range_image(&points, az_bins, el_bins, invert_elevation).map_err(|e| e.to_string())?;
    result.source = "raw_time_window".to_string();
    result.source_detail = Some(format!("center={t_center_sec:.3}s, window={window_sec:.3}s"));
    Ok(result)
}

/// GLIM-map "time-windowed" source: instead of reprojecting the *whole
/// session's* aggregated map (`glim-export-pcd`'s map_export.ply) into "LiDAR
/// frame at time t" — which mixes in points captured from other
/// viewpoints/times and reads as cluttered/ghosted for a moving scene — loads
/// only the GLIM submaps whose own frame timestamps overlap the window. See
/// `hera_runner::submap` for the (reverse-engineered, no upstream spec)
/// per-submap file format this depends on.
#[tauri::command]
pub fn build_range_image_glim_windowed(
    map_dir: String,
    t_center_sec: f64,
    window_sec: f64,
    frame_pose: hera_runner::Pose,
    az_bins: u32,
    el_bins: u32,
    invert_elevation: bool,
) -> Result<hera_runner::RangeImageResult, String> {
    let p = PathBuf::from(&map_dir);
    if !p.exists() {
        return Err(format!("map directory not found: {}", map_dir));
    }
    let points = hera_runner::load_glim_points_windowed(&p, t_center_sec, window_sec).map_err(|e| e.to_string())?;
    let points = hera_runner::world_to_frame(&points, &frame_pose);
    let mut result = hera_runner::build_range_image(&points, az_bins, el_bins, invert_elevation).map_err(|e| e.to_string())?;
    result.source = "glim_submaps".to_string();
    result.source_detail = Some(format!("center={t_center_sec:.3}s, window={window_sec:.3}s"));
    Ok(result)
}

/// First Mid360 sample's `timestamp_host_ns` from a raw
/// `storage-extract-mid360 --points` CSV — the zero-anchor
/// `multi_source_synchronizer` used for its Mid360 axis (see that operator's
/// output `offset_sec`), needed to convert `traj_lidar.txt`'s host-clock
/// timeline position into Insta360 video-relative time. See
/// `hera_runner::rangeimage::first_row_timestamp_host_ns`.
#[tauri::command]
pub fn first_timestamp_host_ns(raw_points_path: String) -> Result<u64, String> {
    let p = PathBuf::from(&raw_points_path);
    if !p.exists() {
        return Err(format!("file not found: {}", raw_points_path));
    }
    hera_runner::first_row_timestamp_host_ns(&p).map_err(|e| e.to_string())
}

/// Loads `<map_dir>/traj_lidar.txt` (GLIM's own loop-closed trajectory output —
/// see `hera_runner::trajectory` doc for where this filename/format comes
/// from) and reports its time range for the timeline control (§7).
#[tauri::command]
pub fn load_trajectory(path: String) -> Result<hera_runner::TrajectoryInfo, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }
    let traj = hera_runner::load_trajectory(&p).map_err(|e| e.to_string())?;
    Ok(hera_runner::trajectory_info(&traj))
}

/// Interpolates the LiDAR pose at `t_query` (seconds, same units as
/// `traj_lidar.txt`) — `Ok(None)` if outside the trajectory's time range,
/// not an error (the UI clamps the slider to the loaded range so this should
/// only happen from a stale/racy call, not normal use).
#[tauri::command]
pub fn interpolate_pose(path: String, t_query: f64) -> Result<Option<hera_runner::Pose>, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("file not found: {}", path));
    }
    let traj = hera_runner::load_trajectory(&p).map_err(|e| e.to_string())?;
    Ok(hera_runner::interpolate_pose(&traj, t_query))
}

/// Read an arbitrary file (the stitched panorama frame) and return it
/// base64-encoded, so the frontend can build a `data:` URL for `<canvas>` without
/// needing the Tauri asset-protocol scope opened up for dynamic hera-output paths.
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Read a small text file (used to seed the param panel from an existing
/// `<stem>.extrinsic.json` if one already exists for this session — task doc
/// §3: "初值:读 extrinsic.json 当前值,不是从零开始搜"). `Ok(None)` when the
/// file doesn't exist yet (first calibration for this session), not an error.
#[tauri::command]
pub fn read_text_file_opt(path: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Refine a candidate extrinsic from ≥3 ERP-pixel/3D-point pairs — see
/// `hera_runner::calib` for the math and the exact rotation convention (matched
/// to the existing `spatial-memory` extrinsic.json / p3_bind_pose.py, NOT this
/// repo's own `injector.rs` mounting_rpy convention, which is unrelated). This
/// only ever returns a *candidate* — the caller must still generate an overlay
/// preview and let the user confirm before `save_extrinsic` (task doc §0: no
/// auto-write without a human looking at it first).
#[tauri::command]
pub fn solve_extrinsic(
    frames: Vec<hera_runner::FrameGroup>,
    initial_extrinsic: hera_runner::Extrinsic,
    erp_width: f64,
    erp_height: f64,
) -> Result<hera_runner::SolveResult, String> {
    hera_runner::solve_extrinsic(&frames, initial_extrinsic, erp_width, erp_height)
        .map_err(|e| e.to_string())
}

/// Projects the point cloud through `extrinsic` onto the panorama frame for
/// visual confirmation. Returns base64 JPEG (same "no asset-protocol scope"
/// reasoning as `read_file_base64`).
#[tauri::command]
pub fn project_overlay(
    pointcloud_path: String,
    extrinsic: hera_runner::Extrinsic,
    panorama_path: String,
    subsample: usize,
    frame_pose: Option<hera_runner::Pose>,
) -> Result<String, String> {
    let pc_path = PathBuf::from(&pointcloud_path);
    if !pc_path.exists() {
        return Err(format!("file not found: {}", pointcloud_path));
    }
    let pano_path = PathBuf::from(&panorama_path);
    if !pano_path.exists() {
        return Err(format!("file not found: {}", panorama_path));
    }

    let mut points = hera_runner::load_points_xyz(&pc_path).map_err(|e| e.to_string())?;
    // Same reasoning as build_range_image: a motion-session point cloud is in
    // GLIM's world frame, not the LiDAR's own frame, so the calib math (which
    // assumes P is LiDAR-frame) needs it re-expressed at the pose the LiDAR
    // actually had when the (fixed, non-timeline-linked) panorama frame was
    // captured — otherwise the overlay is wrong even with a correct extrinsic.
    if let Some(pose) = frame_pose {
        points = hera_runner::world_to_frame(&points, &pose);
    }
    let base = image::open(&pano_path).map_err(|e| e.to_string())?.to_rgb8();
    let overlay = hera_runner::project_overlay(&points, extrinsic, &base, subsample.max(1));

    let mut jpeg_bytes = Vec::new();
    {
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
        encoder
            .encode(overlay.as_raw(), overlay.width(), overlay.height(), image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes))
}

/// Writes `<session_dir>/<stem>.extrinsic.json` — schema extends (never
/// replaces field names of) the existing `work/phase3/extrinsic.json` shape
/// from the spatial-memory project (task doc §6). Appends to `iteration_log`
/// rather than clobbering it if a prior save already exists at this path, so
/// re-solving/re-saving the same session keeps its history.
#[tauri::command]
pub fn save_extrinsic(
    session_path: String,
    extrinsic: hera_runner::Extrinsic,
    point_pairs: Vec<hera_runner::PointPair>,
    residuals_deg: Vec<f64>,
    note: Option<String>,
) -> Result<String, String> {
    let p = PathBuf::from(&session_path);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_string();
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let out_path = dir.join(format!("{}.extrinsic.json", stem));

    let existing: serde_json::Value = std::fs::read_to_string(&out_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let mut iteration_log: Vec<serde_json::Value> = existing
        .get("iteration_log")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let iteration_count = iteration_log.len() as u64 + 1;

    let rms = if residuals_deg.is_empty() {
        0.0
    } else {
        (residuals_deg.iter().map(|d| d * d).sum::<f64>() / residuals_deg.len() as f64).sqrt()
    };
    let note_suffix = note.as_deref().map(|n| format!(" — {}", n)).unwrap_or_default();
    iteration_log.push(serde_json::Value::String(format!(
        "iteration {}: calibration-tool solved from {} point pairs, rms residual {:.3} deg{}",
        iteration_count,
        point_pairs.len(),
        rms,
        note_suffix
    )));

    let known_caveats: Vec<serde_json::Value> = existing
        .get("known_caveats")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let out = serde_json::json!({
        "translation_lidar_to_camera_m": [extrinsic.tx, extrinsic.ty, extrinsic.tz],
        "rotation_lidar_to_camera_euler_xyz_deg": [extrinsic.roll_deg, extrinsic.pitch_deg, extrinsic.yaw_deg],
        "iteration_count": iteration_count,
        "iteration_log": iteration_log,
        "known_caveats": known_caveats,
        "status": "calibration-tool_confirmed",
        "calibrated_by": "calibration-tool",
        "point_pairs_used": point_pairs.len(),
        "residuals_deg": residuals_deg,
        "source_session": stem,
        "motion_state": "static",
    });

    let pretty = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    std::fs::write(&out_path, pretty).map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().to_string())
}

// ── File system ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve whether an external tool is available: a path (containing a separator,
/// or absolute) is checked for existence directly; a bare command name (e.g.
/// "cloudcompare") is searched on `PATH` — `where`/`which` aren't portable, so this
/// walks `PATH` by hand, trying `PATHEXT` suffixes on Windows since bare names there
/// don't include `.exe`/`.bat`/etc.
#[tauri::command]
pub fn resolve_tool(tool: String) -> bool {
    let trimmed = tool.trim();
    if trimmed.is_empty() {
        return false;
    }

    let p = Path::new(trimmed);
    if p.is_absolute() || trimmed.contains('/') || trimmed.contains('\\') {
        return p.is_file();
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };

    #[cfg(target_os = "windows")]
    let exts: Vec<String> = {
        let mut v = vec![String::new()]; // in case the caller already included an extension
        v.extend(
            std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
                .split(';')
                .map(|s| s.to_string()),
        );
        v
    };
    #[cfg(not(target_os = "windows"))]
    let exts: Vec<String> = vec![String::new()];

    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let candidate = dir.join(format!("{trimmed}{ext}"));
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

/// Whether a real, working NVIDIA GPU is present — `nvidia-smi` only exits 0 when
/// the driver is actually loaded and can see a device, so this also catches "driver
/// installed but no GPU attached" cases, not just "binary exists on PATH".
#[tauri::command]
pub fn detect_gpu() -> bool {
    hera_runner::gpu::detect_nvidia_gpu()
}

// ── Config ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<AppConfig, String> {
    Ok(state.config.lock().unwrap().clone())
}

#[tauri::command]
pub fn set_config(config: AppConfig, state: State<AppState>) -> Result<(), String> {
    let toml_str = toml::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, toml_str).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

// ── Operator registry ─────────────────────────────────────────────────────────

/// Add an operator from an image ref (pulled from registry) or a tar file.
///
/// If `manifest_json` is provided it is used directly — the `--describe` container
/// call is skipped.  This is necessary for images whose entrypoint does not
/// implement the `--describe` protocol (e.g. ROS images with /ros_entrypoint.sh).
/// The `version` field inside the manifest is automatically overwritten with the
/// tag portion of `resolved_ref` so that registry entries stay consistent with the
/// pulled image tag.
///
/// Sequence: [load tar | pull] → [--describe | use manifest_json] → inspect digest → validate → register.
#[tauri::command]
pub async fn operator_add(
    image_ref: String,
    tar_path: Option<String>,
    manifest_json: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let container = {
        let cfg = state.config.lock().unwrap();
        cfg.runtime.container.clone()
    };

    // 1. Load from tar if provided
    let resolved_ref = if let Some(tar) = &tar_path {
        let out = tokio::process::Command::new(&container)
            .args(["load", "-i", tar])
            .output()
            .await
            .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
        if !out.status.success() {
            return Err(hera_runner::docker_diag::friendly_docker_error(
                "镜像导入失败 (docker load)",
                &String::from_utf8_lossy(&out.stderr),
            ));
        }
        // Parse "Loaded image: <ref>" from stdout
        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout
            .lines()
            .find(|l| l.starts_with("Loaded image:"))
            .and_then(|l| l.strip_prefix("Loaded image:"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| image_ref.clone())
    } else {
        // Pull from registry (no-op if already local)
        let pull = tokio::process::Command::new(&container)
            .args(["pull", &image_ref])
            .output()
            .await
            .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
        if !pull.status.success() {
            return Err(hera_runner::docker_diag::friendly_docker_error(
                "镜像拉取失败 (docker pull)",
                &String::from_utf8_lossy(&pull.stderr),
            ));
        }
        image_ref.clone()
    };

    // 2. Obtain manifest — either from the caller or via --describe
    let manifest: serde_json::Value = if let Some(provided) = manifest_json {
        // Caller supplied the manifest (e.g. official operators with ROS entrypoints
        // that don't support --describe).  Auto-sync the version field to the image tag.
        let mut m: serde_json::Value = serde_json::from_str(&provided)
            .map_err(|e| format!("provided manifest JSON parse error: {e}"))?;
        let tag = resolved_ref
            .rsplit(':')
            .next()
            .filter(|t| !t.contains('/'))
            .unwrap_or("latest");
        m["version"] = serde_json::Value::String(tag.to_string());
        m
    } else {
        // Ask the container to self-describe.
        let describe = tokio::process::Command::new(&container)
            .args(["run", "--rm", &resolved_ref, "--describe"])
            .output()
            .await
            .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
        if !describe.status.success() {
            return Err(format!(
                "{}\n提示：如果该镜像不支持 --describe 协议，请直接提供 manifest JSON。",
                hera_runner::docker_diag::friendly_docker_error(
                    "获取算子描述失败 (docker run --describe)",
                    &String::from_utf8_lossy(&describe.stderr),
                ),
            ));
        }
        let manifest_str = String::from_utf8_lossy(&describe.stdout);
        serde_json::from_str(&manifest_str)
            .map_err(|e| format!("manifest JSON parse error: {e}\noutput: {manifest_str}"))?
    };

    // 3. Validate required fields
    validate_manifest(&manifest)?;

    let op_id = manifest["id"].as_str().unwrap().to_string();
    let op_version = manifest["version"].as_str().unwrap().to_string();
    let manifest_str = serde_json::to_string(&manifest).unwrap();

    // 4. Get image digest (ImageID = sha256 of config, always available locally)
    let inspect = tokio::process::Command::new(&container)
        .args(["inspect", "--format", "{{.Id}}", &resolved_ref])
        .output()
        .await
        .map_err(|e| hera_runner::docker_diag::friendly_spawn_error(&container, &e))?;
    let digest = String::from_utf8_lossy(&inspect.stdout).trim().to_string();

    // 5. Register
    let source = if tar_path.is_some() { "tar" } else { "registry" };
    {
        let reg = state.registry.lock().unwrap();
        reg.operator_register(&op_id, &op_version, &resolved_ref, &digest, &manifest_str, source)
            .map_err(|e| e.to_string())?;
    }

    Ok(manifest)
}

fn validate_manifest(m: &serde_json::Value) -> Result<(), String> {
    for field in &["spec", "id", "name", "version", "command"] {
        if m.get(field).and_then(|v| v.as_str()).is_none() {
            return Err(format!("manifest missing required string field: {field}"));
        }
    }
    if m.get("inputs").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
        return Err("manifest 'inputs' must be a non-empty array".to_string());
    }
    if m.get("outputs").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
        return Err("manifest 'outputs' must be a non-empty array".to_string());
    }
    if let Some(schema) = m.get("params_schema") {
        if !schema.is_object() {
            return Err("manifest 'params_schema' must be a JSON object".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn operator_list(state: State<AppState>) -> Result<Vec<OperatorSummaryRow>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .operator_list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn operator_describe(
    id: String,
    version: String,
    state: State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    state
        .registry
        .lock()
        .unwrap()
        .operator_describe(&id, &version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn operator_remove(
    id: String,
    version: String,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .unwrap()
        .operator_remove(&id, &version)
        .map_err(|e| e.to_string())
}
