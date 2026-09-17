use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::container::{ContainerRuntime, MountArg};
use crate::injector::StepContext;
use crate::manifest::{GpuMode, IoType, Operator};
use crate::registry::Registry;
use crate::workflow::{Workflow, WorkflowNode};

#[derive(Debug, Clone)]
pub enum JobEvent {
    StepStart { step: String, image: String },
    Log { step: String, text: String, is_stderr: bool },
    StepComplete { step: String },
    // log_path 指向 step_dir/step.log；失败时把它带给前端方便一键打开定位问题。
    StepFailed { step: String, exit_code: i32, reason: String, log_path: Option<String> },
    JobComplete { artifacts: Vec<Artifact> },
    JobFailed { step: String, reason: String },
}

#[derive(Debug, Clone)]
pub struct Artifact {
    pub id: String,
    pub step: String,
    pub output_id: String,
    pub host_path: String,
}

pub struct JobRunner {
    pub job_id: String,
    config: AppConfig,
    runtime: ContainerRuntime,
    operators_dir: PathBuf,
}

impl JobRunner {
    pub fn new(config: AppConfig, operators_dir: impl Into<PathBuf>) -> Self {
        let runtime = ContainerRuntime::new(&config.runtime.container, config.runtime.gpu_enabled);
        Self {
            job_id: Uuid::new_v4().to_string(),
            config,
            runtime,
            operators_dir: operators_dir.into(),
        }
    }

    /// Execute a workflow. Events are sent over the returned channel.
    pub async fn run_workflow(
        &self,
        workflow: &Workflow,
        user_input_path: &Path,
        param_overrides: &HashMap<String, HashMap<String, serde_json::Value>>,
    ) -> mpsc::Receiver<JobEvent> {
        let (tx, rx) = mpsc::channel::<JobEvent>(256);

        let job_dir = self.config.output_dir().join(&self.job_id);
        let operators_dir = self.operators_dir.clone();
        let runtime = self.runtime.clone();
        let config = self.config.clone();
        let workflow = workflow.clone();
        let user_input_path = user_input_path.to_path_buf();
        let param_overrides = param_overrides.clone();
        let job_id = self.job_id.clone();

        tokio::spawn(async move {
            if let Err(e) = run_workflow_inner(
                &job_id,
                &job_dir,
                &operators_dir,
                &runtime,
                &config,
                &workflow,
                &user_input_path,
                &param_overrides,
                &tx,
            )
            .await
            {
                let _ = tx
                    .send(JobEvent::JobFailed {
                        step: "runner".into(),
                        reason: e.to_string(),
                    })
                    .await;
            }
        });

        rx
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_workflow_inner(
    job_id: &str,
    job_dir: &Path,
    operators_dir: &Path,
    runtime: &ContainerRuntime,
    config: &AppConfig,
    workflow: &Workflow,
    user_input_path: &Path,
    param_overrides: &HashMap<String, HashMap<String, serde_json::Value>>,
    tx: &mpsc::Sender<JobEvent>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(job_dir)?;

    // Fail fast when the output partition is nearly full — GLIM writes multi-GB
    // intermediate submaps/graphs and a mid-run ENOSPC surfaces as cryptic
    // downstream errors (JSON parse fail on a truncated write, ENAMETOOLONG on a
    // hashed temp path, etc.) that are hard to trace back to disk pressure.
    // 5 GB threshold is arbitrary but covers a typical medium recon.
    if let Some(parent) = job_dir.parent() {
        if let Some(free_gb) = free_space_gb(parent) {
            if free_gb < 5 {
                anyhow::bail!(
                    "输出目录所在分区剩余空间不足 ({} GB < 5 GB 阈值)：{}\n\
                     GLIM 会写数 GB 中间数据，磁盘接近满时会失败。请先清理磁盘再重试。\n\
                     推荐：docker system prune -a --volumes -f  可回收大量空间。",
                    free_gb,
                    parent.display()
                );
            }
        }
    }

    // Docker bind mounts require absolute paths
    let job_dir = job_dir
        .canonicalize()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default().join(job_dir));
    // On Windows, canonicalize() always returns the `\\?\` extended-length ("verbatim")
    // prefix form (e.g. `\\?\C:\Program Files\...`). Docker Desktop's bind-mount spec
    // parser doesn't understand it — combined with the drive-letter colon it miscounts
    // colons in `host:container:mode` and rejects the mount ("too many colons"). Strip
    // it back to the plain `C:\...` form Docker expects; no-op elsewhere.
    let job_dir = strip_windows_verbatim_prefix(job_dir);

    let sorted = workflow.topo_sorted_nodes();

    // Map step_id -> resolved output host paths
    let mut step_outputs: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut all_artifacts: Vec<Artifact> = Vec::new();

    for node in sorted {
        let (op, image_ref, image_digest, resolved_version) = load_operator_for_step(
            &config.registry.db_path,
            operators_dir,
            &node.operator,
            node.version.as_deref(),
        )?;
        let step_dir = job_dir.join(&node.id);
        std::fs::create_dir_all(&step_dir)?;

        // Resolve inputs
        let inputs = resolve_inputs(
            workflow,
            node,
            user_input_path,
            &step_outputs,
            &op,
            &step_dir,
        )?;

        // Resolve outputs (host side)
        let outputs = resolve_outputs(&op, &step_dir);

        // Merge param overrides
        let mut params = node.params.clone();
        if let Some(overrides) = param_overrides.get(&node.id) {
            for (k, v) in overrides {
                params.insert(k.clone(), v.clone());
            }
        }

        // Prepare job-local config copy if operator has rw config mount
        let job_config_dir = prepare_config_dir(config, &op, &step_dir)?;

        let ctx = StepContext {
            op: &op,
            inputs: inputs.clone(),
            outputs: outputs.clone(),
            params,
            job_config_dir: job_config_dir.clone().map(|p| p.to_string_lossy().to_string()),
        };

        // Apply config patches before running
        ctx.apply_config_patches()?;

        let mut env = ctx.env_vars();
        // Pass OSS credentials through from the host process environment (never from
        // a config file or operator manifest) for operators that upload/download via
        // OSS — e.g. panorama-stitch's FC client for recordings too large for a
        // direct HTTP body. No-op for operators that don't read these.
        for key in ["OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_ENDPOINT"] {
            if let Ok(val) = std::env::var(key) {
                env.insert(key.to_string(), val);
            }
        }
        let command = ctx.expand_command()?;

        // Build mount list
        let mounts: Vec<MountArg> = build_mounts(&op, &inputs, &outputs, &job_config_dir);

        let _ = tx
            .send(JobEvent::StepStart {
                step: node.id.clone(),
                image: op.image.clone(),
            })
            .await;

        let needs_gpu = matches!(op.gpu, GpuMode::Required)
            || (matches!(op.gpu, GpuMode::Optional) && config.runtime.gpu_enabled);

        let container_name = format!("hera-{}-{}", job_id, node.id);
        let (exit_code, mut log_rx) = runtime
            .run(&op.image, needs_gpu, &mounts, &env, &command, &container_name)
            .await?;

        // 把 stdout+stderr 都落到 step_dir/step.log。事后诊断 / 用户查看用；
        // 前端流式 UI 仍然通过 JobEvent::Log 事件推送，两条路互不影响。
        let log_path = step_dir.join("step.log");
        let mut log_file = std::fs::File::create(&log_path).ok();

        let mut stderr_tail: Vec<String> = Vec::new();
        while let Some(line) = log_rx.recv().await {
            let is_stderr = matches!(line.stream, crate::container::Stream::Stderr);
            if is_stderr {
                stderr_tail.push(line.text.clone());
                if stderr_tail.len() > 40 {
                    stderr_tail.remove(0);
                }
            }
            if let Some(f) = log_file.as_mut() {
                let prefix = if is_stderr { "[E] " } else { "[O] " };
                let _ = writeln!(f, "{}{}", prefix, line.text);
            }
            let _ = tx
                .send(JobEvent::Log {
                    step: node.id.clone(),
                    text: line.text,
                    is_stderr,
                })
                .await;
        }
        drop(log_file);

        if !op.exit_codes_ok.contains(&exit_code) {
            let log_path_str = log_path.to_string_lossy().to_string();
            let reason = if stderr_tail.is_empty() {
                format!(
                    "步骤 {} 执行失败（退出码 {}）。完整日志：{}",
                    node.id, exit_code, log_path_str
                )
            } else {
                let base = crate::docker_diag::friendly_docker_error(
                    &format!("步骤 {} 执行失败（退出码 {}）", node.id, exit_code),
                    &stderr_tail.join("\n"),
                );
                format!("{}\n\n完整日志：{}", base, log_path_str)
            };
            let _ = tx
                .send(JobEvent::StepFailed {
                    step: node.id.clone(),
                    exit_code,
                    reason: reason.clone(),
                    log_path: Some(log_path_str),
                })
                .await;
            return Err(anyhow::anyhow!(reason));
        }

        // Silent-failure guard: some GPU containers (e.g. Insta360 MediaSDKTest fed
        // the wrong file type) print an init line, exit 0, and produce no output.
        // Without this check the framework happily reports success while the step
        // dir stays empty and downstream nodes get missing inputs. See
        // hera-output/{2867ef98,3e843a6c,43493a01,...} for concrete cases where a
        // .hera path was passed to a workflow declaring .insv input.
        let mut missing_outputs: Vec<String> = Vec::new();
        for out in &op.outputs {
            let host_path = match outputs.get(&out.id) {
                Some(p) => Path::new(p),
                None => continue, // shouldn't happen; resolve_outputs filled all declared outputs
            };
            let ok = match out.io_type {
                crate::manifest::IoType::File => host_path
                    .metadata()
                    .map(|m| m.is_file() && m.len() > 0)
                    .unwrap_or(false),
                crate::manifest::IoType::Dir => host_path.is_dir()
                    && std::fs::read_dir(host_path)
                        .map(|mut it| it.next().is_some())
                        .unwrap_or(false),
            };
            if !ok {
                missing_outputs.push(format!("{} ({})", out.id, host_path.display()));
            }
        }
        if !missing_outputs.is_empty() {
            let log_path_str = log_path.to_string_lossy().to_string();
            let reason = format!(
                "步骤 {} 退出码为 0 但没有产出声明的输出：{}。\n\
                 常见原因：容器接收了错误类型的输入文件、GPU/CUDA 初始化静默失败、\n\
                 或磁盘/权限问题。\n\n完整日志：{}",
                node.id,
                missing_outputs.join(", "),
                log_path_str,
            );
            let _ = tx
                .send(JobEvent::StepFailed {
                    step: node.id.clone(),
                    exit_code,
                    reason: reason.clone(),
                    log_path: Some(log_path_str),
                })
                .await;
            return Err(anyhow::anyhow!(reason));
        }

        let _ = tx.send(JobEvent::StepComplete { step: node.id.clone() }).await;

        // Record provenance
        if let Ok(reg) = Registry::open(Path::new(&config.registry.db_path)) {
            let params_str = serde_json::to_string(&node.params).unwrap_or_default();
            let _ = reg.record_step_provenance(
                job_id,
                &node.id,
                &node.operator,
                &resolved_version,
                &image_ref,
                &image_digest,
                &params_str,
            );
        }

        // Register outputs
        step_outputs.insert(node.id.clone(), outputs.clone());
        for (out_id, host_path) in &outputs {
            all_artifacts.push(Artifact {
                id: format!("{}/{}/{}", job_id, node.id, out_id),
                step: node.id.clone(),
                output_id: out_id.clone(),
                host_path: host_path.clone(),
            });
        }
    }

    let _ = tx.send(JobEvent::JobComplete { artifacts: all_artifacts }).await;
    Ok(())
}

/// Load operator manifest: registry-first, then fallback to operators/<id>/operator.json.
/// Returns (Operator, image_ref, image_digest, resolved_version).
fn load_operator_for_step(
    db_path: &str,
    operators_dir: &Path,
    id: &str,
    version: Option<&str>,
) -> anyhow::Result<(Operator, String, String, String)> {
    let ver = version.unwrap_or("latest");

    // 1. Try registry lookup
    if let Ok(reg) = Registry::open(Path::new(db_path)) {
        if let Ok(Some((manifest_json, image_ref, image_digest, resolved_ver))) =
            reg.resolve_operator(id, ver)
        {
            let mut op: Operator = Operator::from_json_str(&manifest_json)
                .map_err(|e| anyhow::anyhow!("registry manifest parse error for {id}: {e}"))?;
            // Self-describe manifests omit 'image'; fill from registry
            if op.image.is_empty() {
                op.image = image_ref.clone();
            }
            tracing::debug!(
                "Loaded operator {id}@{resolved_ver} from registry (image={image_ref})"
            );
            return Ok((op, image_ref, image_digest, resolved_ver));
        }
    }

    // 2. Fallback: operators/<id>/operator.json (external file, has 'image' field)
    let path = operators_dir.join(id).join("operator.json");
    let op = Operator::load(&path)?;
    let image_ref = op.image.clone();
    let version_str = op.version.clone();
    tracing::debug!("Loaded operator {id} from file (image={image_ref})");
    Ok((op, image_ref, "unknown".to_string(), version_str))
}

fn resolve_inputs(
    workflow: &Workflow,
    node: &WorkflowNode,
    user_input_path: &Path,
    step_outputs: &HashMap<String, HashMap<String, String>>,
    _op: &Operator,
    _step_dir: &Path,
) -> anyhow::Result<HashMap<String, String>> {
    let mut inputs: HashMap<String, String> = HashMap::new();

    // Check if this node receives the workflow-level user input
    if workflow.workflow_input_to.node == node.id {
        let input_id = &workflow.workflow_input_to.input;
        inputs.insert(input_id.clone(), user_input_path.to_string_lossy().to_string());
    }

    // Resolve inputs from upstream edges
    for edge in &workflow.edges {
        if edge.to_node == node.id {
            if let Some(upstream_outputs) = step_outputs.get(&edge.from_node) {
                if let Some(host_path) = upstream_outputs.get(&edge.from_output) {
                    inputs.insert(edge.to_input.clone(), host_path.clone());
                }
            }
        }
    }

    Ok(inputs)
}

fn resolve_outputs(op: &Operator, step_dir: &Path) -> HashMap<String, String> {
    let mut outputs = HashMap::new();
    for out in &op.outputs {
        // Derive host path from container path basename
        let name = Path::new(&out.container)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&out.id);
        let host_path = step_dir.join(name);
        outputs.insert(out.id.clone(), host_path.to_string_lossy().to_string());
    }
    outputs
}

fn prepare_config_dir(
    config: &AppConfig,
    op: &Operator,
    step_dir: &Path,
) -> anyhow::Result<Option<PathBuf>> {
    let rw_mount = match op.mounts.iter().find(|m| m.mode == "rw") {
        Some(m) => m,
        None => return Ok(None),
    };

    // Priority 1: explicit glim_config_dir in config
    let source = if let Some(d) = config.glim_config_dir() {
        d
    } else if let Some(image_path) = &rw_mount.image_config_path {
        // Priority 2: auto-extract from image and cache
        let cache = config.config_cache_dir().join(&op.id).join("config");
        // Check for existence AND non-emptiness: a prior interrupted extraction can
        // leave the cache dir created but empty (create_dir_all succeeds before
        // `docker cp` runs). Without the empty check, subsequent runs skip
        // extraction, copy 0 files to job config, and downstream patching fails
        // with cryptic errors on missing config_sensors.json / config.json.
        let cache_populated = cache.is_dir()
            && std::fs::read_dir(&cache)
                .map(|mut it| it.next().is_some())
                .unwrap_or(false);
        if !cache_populated {
            if cache.exists() {
                tracing::warn!(
                    "Config cache {} exists but is empty (likely from an interrupted \
                     previous extraction), re-extracting from image {} ...",
                    cache.display(), op.image
                );
                let _ = std::fs::remove_dir_all(&cache);
            } else {
                tracing::info!(
                    "Config cache not found for {}, extracting from image {} ...",
                    op.id, op.image
                );
            }
            extract_config_from_image(&op.image, image_path, &cache)?;
            tracing::info!("Config extracted to {}", cache.display());
        }
        cache
    } else {
        return Err(anyhow::anyhow!(
            "Operator '{}' needs a writable config directory but glim_config_dir is not set \
             and no image_config_path is defined in the mount. \
             Set [data] glim_config_dir in config.toml.",
            op.id
        ));
    };

    // Copy to a per-job directory so patches don't affect the source
    let dest = step_dir.join("config");
    copy_dir_all(&source, &dest)?;
    Ok(Some(dest))
}

/// Extract a directory from a container image to a local path using docker create/cp/rm.
pub fn extract_config_from_image(
    image: &str,
    container_path: &str,
    dest: &Path,
) -> anyhow::Result<()> {
    use std::process::Command;

    std::fs::create_dir_all(dest)?;

    let container_name = format!("hera-cfg-{}", uuid::Uuid::new_v4().simple());

    let create = Command::new("docker")
        .args(["create", "--name", &container_name, image, "true"])
        .output()
        .map_err(|e| anyhow::anyhow!(crate::docker_diag::friendly_spawn_error("docker", &e)))?;
    if !create.status.success() {
        return Err(anyhow::anyhow!(crate::docker_diag::friendly_docker_error(
            "提取算子配置失败 (docker create)",
            &String::from_utf8_lossy(&create.stderr),
        )));
    }

    // docker cp <container>:/path/. <dest> copies contents (not the dir itself)
    let src_spec = format!(
        "{}:{}/.",
        container_name,
        container_path.trim_end_matches('/')
    );
    let cp = Command::new("docker")
        .args(["cp", &src_spec, &dest.to_string_lossy()])
        .output();

    // Always remove the temporary container
    let _ = Command::new("docker")
        .args(["rm", &container_name])
        .output();

    let cp = cp.map_err(|e| anyhow::anyhow!(crate::docker_diag::friendly_spawn_error("docker", &e)))?;
    if !cp.status.success() {
        return Err(anyhow::anyhow!(crate::docker_diag::friendly_docker_error(
            "提取算子配置失败 (docker cp)",
            &String::from_utf8_lossy(&cp.stderr),
        )));
    }
    Ok(())
}

/// Strip the Windows `\\?\` verbatim-path prefix that `Path::canonicalize()` always
/// adds on that platform (`\\?\C:\...` -> `C:\...`, `\\?\UNC\server\share` ->
/// `\\server\share`). A plain string match, not `#[cfg(windows)]`-gated: the prefix
/// never appears in paths produced on Linux/macOS, so this is a no-op there.
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(test)]
mod verbatim_prefix_tests {
    use super::*;

    #[test]
    fn strips_local_drive_verbatim_prefix() {
        // Exact case reported from a real Windows run.
        let p = PathBuf::from(
            r"\\?\C:\Program Files\Hera Desktop\hera-output\20acbfb3-a9da-4024-b030-5bfb9335553f\step_recon\map",
        );
        let got = strip_windows_verbatim_prefix(p);
        assert_eq!(
            got.to_string_lossy(),
            r"C:\Program Files\Hera Desktop\hera-output\20acbfb3-a9da-4024-b030-5bfb9335553f\step_recon\map"
        );
    }

    #[test]
    fn strips_unc_verbatim_prefix() {
        let p = PathBuf::from(r"\\?\UNC\server\share\dir");
        let got = strip_windows_verbatim_prefix(p);
        assert_eq!(got.to_string_lossy(), r"\\server\share\dir");
    }

    #[test]
    fn leaves_plain_unix_path_untouched() {
        let p = PathBuf::from("/home/user/hera-output/job/step/map");
        let got = strip_windows_verbatim_prefix(p.clone());
        assert_eq!(got, p);
    }

    #[test]
    fn leaves_plain_windows_path_untouched() {
        let p = PathBuf::from(r"C:\Users\fred\hera-output\job\step\map");
        let got = strip_windows_verbatim_prefix(p.clone());
        assert_eq!(got, p);
    }
}

/// Query free space (GiB) on the partition containing `path`. Returns None if
/// the query fails for any reason (missing df binary, unusual mount, etc.) —
/// callers treat that as "unknown, skip the check" rather than fatal.
fn free_space_gb(path: &Path) -> Option<u64> {
    // Portable-ish: shell out to `df -B1 --output=avail`. Skips POSIX statvfs
    // FFI and keeps the runner dep-free. Works on Linux/macOS `df` (GNU or BSD
    // with slight header diffs — the `--output=avail` flag is GNU only but
    // that's what our target platforms have).
    let out = std::process::Command::new("df")
        .args(["-B1", "--output=avail"])
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // Skip header line, parse number from data line
    let bytes: u64 = s.lines().nth(1)?.trim().parse().ok()?;
    Some(bytes / (1024 * 1024 * 1024))
}

fn copy_dir_all(src: &Path, dst: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn build_mounts(
    op: &Operator,
    inputs: &HashMap<String, String>,
    outputs: &HashMap<String, String>,
    job_config_dir: &Option<PathBuf>,
) -> Vec<MountArg> {
    let mut mounts: Vec<MountArg> = Vec::new();

    // Input mounts (ro) — use effective container path so file extensions are preserved
    for inp in &op.inputs {
        if let Some(host) = inputs.get(&inp.id) {
            let container = inp.effective_container_path(host);
            mounts.push(MountArg::ro(host, container));
        }
    }

    // Output mounts (rw) — ensure host dir exists
    for out in &op.outputs {
        if let Some(host) = outputs.get(&out.id) {
            let host_path = Path::new(host);
            match out.io_type {
                IoType::Dir => {
                    let _ = std::fs::create_dir_all(host_path);
                    mounts.push(MountArg::rw(host, &out.container));
                }
                IoType::File => {
                    if let Some(parent) = host_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    // Mount the parent dir, not the file itself
                    let parent = host_path
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| ".".to_string());
                    let container_parent = Path::new(&out.container)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "/output".to_string());
                    mounts.push(MountArg::rw(parent, container_parent));
                }
            }
        }
    }

    // Config mount (rw copy)
    if let Some(cfg_dir) = job_config_dir {
        for m in &op.mounts {
            if m.mode == "rw" {
                mounts.push(MountArg::rw(
                    cfg_dir.to_string_lossy().to_string(),
                    &m.container,
                ));
            } else {
                mounts.push(MountArg::ro(
                    cfg_dir.to_string_lossy().to_string(),
                    &m.container,
                ));
            }
        }
    }

    mounts
}
