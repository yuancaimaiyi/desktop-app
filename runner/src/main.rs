use std::collections::HashMap;
use std::path::{Path, PathBuf};
use clap::{Parser, Subcommand};
use hera_runner::{extract_config_from_image, JobEvent, JobRunner, Operator, Workflow};
use hera_runner::config::AppConfig;
use hera_runner::registry::Registry;

#[derive(Parser)]
#[command(name = "hera-run", about = "Hera local DAG runner")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,

    /// Path to config.toml
    #[arg(long, global = true, default_value = "config.toml")]
    config: PathBuf,

    /// Path to operators directory
    #[arg(long, global = true, default_value = "operators")]
    operators: PathBuf,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run a workflow
    Run {
        /// Workflow JSON file or id (e.g. reconstruct_pointcloud)
        workflow: String,
        /// Input file or directory
        #[arg(long)]
        input: PathBuf,
        /// Param overrides in form node_id.param_id=value
        #[arg(long = "set")]
        set: Vec<String>,
        /// Workflows directory
        #[arg(long, default_value = "workflows")]
        workflows: PathBuf,
    },
    /// Extract an operator's in-image config to a local directory (run once before first use)
    ExtractConfig {
        /// Operator id (e.g. glim-recon)
        operator: String,
        /// Destination directory (default: ~/.cache/hera/<operator>/config)
        #[arg(long)]
        dest: Option<PathBuf>,
    },
    /// List indexed datasets
    Datasets,
    /// List jobs
    Jobs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("hera_runner=debug".parse()?),
        )
        .init();

    let cli = Cli::parse();

    let config = if cli.config.exists() {
        AppConfig::load(&cli.config)?
    } else {
        eprintln!("Warning: config.toml not found, using defaults");
        AppConfig::default()
    };

    match cli.command {
        Cmd::Run { workflow, input, set, workflows } => {
            cmd_run(&config, &cli.operators, &workflows, &workflow, &input, &set).await?;
        }
        Cmd::ExtractConfig { operator, dest } => {
            cmd_extract_config(&config, &cli.operators, &operator, dest.as_deref())?;
        }
        Cmd::Datasets => {
            let db = Registry::open(Path::new(&config.registry.db_path))?;
            for d in db.list_datasets()? {
                println!("{}\t{}\t{}", d.path, d.file_type, d.indexed_at);
            }
        }
        Cmd::Jobs => {
            let db = Registry::open(Path::new(&config.registry.db_path))?;
            for j in db.list_jobs()? {
                println!("{}\t{}\t{}\t{}", j.id, j.workflow_id, j.status, j.started_at);
            }
        }
    }

    Ok(())
}

fn cmd_extract_config(
    config: &AppConfig,
    operators_dir: &Path,
    operator_id: &str,
    dest: Option<&Path>,
) -> anyhow::Result<()> {
    let op_path = operators_dir.join(operator_id).join("operator.json");
    let op = Operator::load(&op_path)?;

    let rw_mount = op
        .mounts
        .iter()
        .find(|m| m.mode == "rw")
        .ok_or_else(|| anyhow::anyhow!("Operator '{}' has no rw config mount", operator_id))?;

    let image_path = rw_mount.image_config_path.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "Mount '{}' in operator '{}' has no image_config_path field",
            rw_mount.id,
            operator_id
        )
    })?;

    let default_dest = config.config_cache_dir().join(operator_id).join("config");
    let dest = dest.unwrap_or(&default_dest);

    println!("Extracting config from image  : {}", op.image);
    println!("  image path  : {}", image_path);
    println!("  destination : {}", dest.display());

    if dest.exists() {
        println!(
            "  (destination already exists — delete it first to re-extract: rm -rf {})",
            dest.display()
        );
        println!("  Skipping extraction.");
    } else {
        extract_config_from_image(&op.image, image_path, dest)?;
        println!("  Done. Files extracted:");
        for entry in std::fs::read_dir(dest)? {
            let entry = entry?;
            println!("    {}", entry.file_name().to_string_lossy());
        }
    }

    println!();
    println!(
        "Add to your config.toml:\n  [data]\n  glim_config_dir = \"{}\"",
        dest.display()
    );
    Ok(())
}

async fn cmd_run(
    config: &AppConfig,
    operators_dir: &Path,
    workflows_dir: &Path,
    workflow_arg: &str,
    input: &Path,
    set_args: &[String],
) -> anyhow::Result<()> {
    let wf_path = if workflow_arg.ends_with(".json") {
        PathBuf::from(workflow_arg)
    } else {
        workflows_dir.join(format!("{}.json", workflow_arg))
    };
    let workflow = Workflow::load(&wf_path)?;

    let mut param_overrides: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    for s in set_args {
        let (lhs, rhs) = s.split_once('=').ok_or_else(|| {
            anyhow::anyhow!("--set must be node_id.param_id=value, got: {}", s)
        })?;
        let (node_id, param_id) = lhs.split_once('.').ok_or_else(|| {
            anyhow::anyhow!("--set lhs must be node_id.param_id, got: {}", lhs)
        })?;
        // Try JSON first so arrays/objects work: --set node.param=[0,0,0,1,0,0,0]
        // Unquoted plain strings fail JSON parse and fall back to String.
        let value: serde_json::Value = serde_json::from_str(rhs)
            .unwrap_or_else(|_| serde_json::Value::String(rhs.to_string()));
        param_overrides
            .entry(node_id.to_string())
            .or_default()
            .insert(param_id.to_string(), value);
    }

    let db = Registry::open(Path::new(&config.registry.db_path))?;
    let runner = JobRunner::new(config.clone(), operators_dir);
    let job_id = runner.job_id.clone();

    db.start_job(
        &job_id,
        &workflow.id,
        &input.to_string_lossy(),
        &serde_json::to_string(&param_overrides)?,
    )?;

    println!("[hera-run] job {} — workflow '{}'", job_id, workflow.name);
    println!("[hera-run] input: {}", input.display());

    let mut rx = runner.run_workflow(&workflow, input, &param_overrides).await;
    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            JobEvent::StepStart { step, image } => {
                println!("[{}] starting  image={}", step, image);
            }
            JobEvent::Log { step, text, is_stderr } => {
                if is_stderr {
                    eprintln!("[{}] {}", step, text);
                } else {
                    println!("[{}] {}", step, text);
                }
            }
            JobEvent::StepComplete { step } => {
                println!("[{}] ✓ done", step);
            }
            JobEvent::StepFailed { step, exit_code, reason, log_path } => {
                eprintln!("[{}] ✗ FAILED  exit={}\n{}", step, exit_code, reason);
                if let Some(p) = log_path {
                    eprintln!("[{}] log: {}", step, p);
                }
            }
            JobEvent::JobComplete { artifacts } => {
                success = true;
                println!("\n[hera-run] workflow complete — artifacts:");
                for a in &artifacts {
                    println!("  {} -> {}", a.output_id, a.host_path);
                    let _ = db.insert_artifact(
                        &a.id,
                        &job_id,
                        &a.step,
                        &a.output_id,
                        &a.host_path,
                    );
                }
            }
            JobEvent::JobFailed { step, reason } => {
                eprintln!("[hera-run] FAILED at step '{}': {}", step, reason);
            }
        }
    }

    db.finish_job(&job_id, success)?;
    if !success {
        std::process::exit(1);
    }
    Ok(())
}
