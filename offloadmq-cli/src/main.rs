mod client;
mod commands;
mod config;
mod models;
mod output;

use clap::{Parser, Subcommand};
use owo_colors::OwoColorize;

/// Standalone command-line client for the OffloadMQ management API.
///
/// Run `omqcli auth --key <management-key>` once to store credentials in
/// ~/.omqcli.yaml, then use the other commands to inspect and manage agents.
#[derive(Parser)]
#[command(name = "omqcli", version, about, long_about = None)]
struct Cli {
    /// Per-request HTTP timeout in seconds (default 15, or $OMQCLI_HTTP_TIMEOUT);
    /// slavemode commands have their own --timeout
    #[arg(long, global = true)]
    http_timeout: Option<u64>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Save the management API key (and optionally the server URL) to ~/.omqcli.yaml
    Auth {
        /// Management API key (the server's MGMT_TOKEN)
        #[arg(long)]
        key: String,
        /// Base URL of the OffloadMQ server (default: http://localhost:3069, or the
        /// previously saved value if already configured)
        #[arg(long)]
        server: Option<String>,
    },
    /// List agents, online capabilities, or tasks
    List {
        #[command(subcommand)]
        target: ListTarget,
    },
    /// Show full details for a single resource
    Describe {
        #[command(subcommand)]
        target: DescribeTarget,
    },
    /// Delete a resource
    Delete {
        #[command(subcommand)]
        target: DeleteTarget,
    },
    /// Run a slavemode command (self-management task) on one agent
    Agent {
        /// Agent id, short id, display name, or machine fingerprint
        id: String,
        #[command(subcommand)]
        action: AgentAction,
    },
    /// One-shot dashboard: online agents, running/scheduled tasks, bucket
    /// quotas, and available capabilities
    Status {
        /// Max number of running and of scheduled tasks to list
        #[arg(long, default_value_t = 5)]
        task_limit: usize,
    },
    /// Fetch agent records or Kubernetes pod diagnostics and logs
    Logs {
        #[command(subcommand)]
        target: LogsTarget,
    },
    /// Inspect execution-history records and aggregate statistics
    Heuristics {
        #[command(subcommand)]
        target: HeuristicsTarget,
    },
    /// Inspect and manage buckets owned by every client API key
    Storage {
        #[command(subcommand)]
        target: StorageTarget,
    },
    /// Cancel a running or queued resource
    Cancel {
        #[command(subcommand)]
        target: CancelTarget,
    },
    /// Reset (permanently clear) all of a resource type
    Reset {
        #[command(subcommand)]
        target: ResetTarget,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Re-detect capabilities and push the updated list to the server
    ForceRescan {
        /// Max seconds to wait for the agent
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Check for, or install, an agent binary update
    Update {
        /// Only report current/latest versions; do not install
        #[arg(long)]
        check: bool,
        /// Max seconds to wait for the agent
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Manage custom capability definitions
    Caps {
        #[command(subcommand)]
        action: CapsAction,
    },
    /// Manage Ollama models
    Ollama {
        #[command(subcommand)]
        action: OllamaAction,
    },
    /// Manage ONNX models
    Onnx {
        #[command(subcommand)]
        action: OnnxAction,
    },
    /// Control the agent-managed local ComfyUI server
    Comfy {
        #[command(subcommand)]
        action: ComfyAction,
    },
}

#[derive(Subcommand)]
enum ComfyAction {
    /// Start ComfyUI and wait until it answers
    Start {
        /// Max seconds to wait (ComfyUI with many custom nodes boots slowly)
        #[arg(long, default_value_t = 360)]
        timeout: u64,
    },
    /// Stop ComfyUI (only if the agent started it)
    Stop {
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Restart ComfyUI and wait until it answers
    Restart {
        #[arg(long, default_value_t = 360)]
        timeout: u64,
    },
    /// Show ComfyUI process state
    Status {
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
}

#[derive(Subcommand)]
enum CapsAction {
    /// List custom capability definitions
    Get {
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Create or replace a custom capability definition
    Set {
        /// JSON object describing the capability, or @path/to/file.json
        json: String,
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Delete a custom capability definition by name
    Delete {
        name: String,
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
}

#[derive(Subcommand)]
enum OllamaAction {
    /// List installed Ollama models
    List {
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Pull (download) an Ollama model
    Pull {
        model: String,
        /// Max seconds of silence between progress updates before giving up
        #[arg(long, default_value_t = 1800)]
        timeout: u64,
    },
    /// Delete an installed Ollama model
    Delete {
        model: String,
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
}

#[derive(Subcommand)]
enum OnnxAction {
    /// List known ONNX models and their install state
    List {
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
    /// Download an ONNX model
    Prepare {
        model: String,
        /// Max seconds of silence between progress updates before giving up
        #[arg(long, default_value_t = 1800)]
        timeout: u64,
    },
    /// Delete a downloaded ONNX model
    Delete {
        model: String,
        #[arg(long, default_value_t = 60)]
        timeout: u64,
    },
}

#[derive(Subcommand)]
enum ListTarget {
    /// List all registered agents (online and offline)
    Agents {
        /// Only show agents that contacted the server within the last 120 seconds
        #[arg(long)]
        online: bool,
    },
    /// List capabilities currently provided by online agents
    #[command(alias = "capabilities")]
    Caps {
        /// Include extended attributes in brackets, e.g. llm.qwen3:8b[vision;tools]
        #[arg(long)]
        ext: bool,
    },
    /// List all tasks (urgent/regular, assigned/unassigned)
    Tasks {
        /// Only show queued/unassigned tasks
        #[arg(long)]
        unassigned_only: bool,
        /// Only show tasks for one capability
        #[arg(long)]
        cap: Option<String>,
        /// Which assigned tasks to fetch: active (unfinished), terminal (finished) or all
        #[arg(long, value_parser = ["active", "terminal", "all"])]
        status: Option<String>,
        /// Max tasks per list, newest first (server default 200, max 1000)
        #[arg(long)]
        limit: Option<usize>,
        /// Fetch as much as the server allows (status=all, limit=1000)
        #[arg(long, conflicts_with_all = ["status", "limit"])]
        all: bool,
    },
}

#[derive(Subcommand)]
enum DescribeTarget {
    /// Show details for one agent (full uid, short id, display name, or fingerprint)
    Agent {
        /// Agent id, short id, display name, or machine fingerprint
        id: String,
    },
    /// Show full detail for one task: metadata, payload, result, log, history
    Task {
        /// Task capability (queue)
        cap: String,
        /// Task id
        id: String,
    },
}

#[derive(Subcommand)]
enum DeleteTarget {
    /// Permanently remove an agent from the registry
    Agent {
        /// Agent id, short id, display name, or machine fingerprint
        id: String,
        /// Skip the confirmation prompt
        #[arg(short = 'y', long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum CancelTarget {
    /// Cancel one task, queued or in-flight (bypasses client-key ownership checks)
    Task {
        /// Task capability (queue)
        cap: String,
        /// Task id
        id: String,
        /// Skip the confirmation prompt
        #[arg(short = 'y', long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum ResetTarget {
    /// Clear every task — urgent and regular, queued and running. Destructive.
    Tasks {
        /// Skip the confirmation prompt
        #[arg(short = 'y', long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum LogsTarget {
    /// Fetch persisted agent logs (latest, one agent, or selected severities)
    Agent {
        /// Restrict records to one agent UID
        #[arg(long, conflicts_with = "severity")]
        agent: Option<String>,
        /// Restrict records to a severity; repeat for multiple values
        #[arg(long, value_parser = ["CRITICAL", "ERROR", "INFO"], conflicts_with = "agent")]
        severity: Vec<String>,
        /// Maximum records to return; pass -1 for all matching records
        #[arg(long, default_value_t = 100, allow_hyphen_values = true)]
        limit: i64,
    },
    /// Fetch pod status and container logs (in-cluster deployments only)
    Pod {
        /// Stack component to inspect
        #[arg(long, default_value = "server", value_parser = ["server", "frontend"])]
        component: String,
        /// Number of log lines to request (1–10000)
        #[arg(
            long,
            default_value_t = 500,
            value_parser = clap::value_parser!(u32).range(1..=10_000)
        )]
        tail_lines: u32,
        /// Container name; defaults to the component's primary container
        #[arg(long)]
        container: Option<String>,
        /// Fetch logs from the previous terminated container instance
        #[arg(long)]
        previous: bool,
        /// Include Kubernetes timestamps in the log stream
        #[arg(long)]
        timestamps: bool,
    },
}

#[derive(Subcommand)]
enum HeuristicsTarget {
    /// List raw execution records, optionally continuing from a cursor
    Records {
        #[arg(long)]
        capability: Option<String>,
        #[arg(long)]
        runner_id: Option<String>,
        #[arg(long)]
        machine_id: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// List aggregate execution statistics by capability and agent
    Runners,
    /// List aggregate execution statistics by capability and machine
    Machines,
}

#[derive(Subcommand)]
enum StorageTarget {
    /// List every bucket, grouped by owning client API key, with quotas
    List,
    /// Show quota usage, optionally for one client API key
    Quotas {
        #[arg(long)]
        api_key: Option<String>,
    },
    /// Permanently delete one bucket and all of its files
    Delete {
        bucket_uid: String,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Permanently delete every bucket for one client API key
    DeleteKey {
        api_key: String,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Permanently delete every bucket across all client API keys
    Purge {
        #[arg(short = 'y', long)]
        yes: bool,
    },
}

fn main() {
    let cli = Cli::parse();
    if let Some(secs) = cli
        .http_timeout
        .or_else(|| std::env::var("OMQCLI_HTTP_TIMEOUT").ok()?.parse().ok())
    {
        client::set_http_timeout(secs);
    }

    let result = match cli.command {
        Command::Auth { key, server } => commands::auth::run(key, server),
        Command::List { target } => match target {
            ListTarget::Agents { online } => commands::list::agents(online),
            ListTarget::Caps { ext } => commands::list::capabilities(ext),
            ListTarget::Tasks {
                unassigned_only,
                cap,
                status,
                limit,
                all,
            } => commands::task::list(unassigned_only, cap, status, limit, all),
        },
        Command::Describe { target } => match target {
            DescribeTarget::Agent { id } => commands::describe::agent(&id),
            DescribeTarget::Task { cap, id } => commands::task::describe(&cap, &id),
        },
        Command::Delete { target } => match target {
            DeleteTarget::Agent { id, yes } => commands::delete::agent(&id, yes),
        },
        Command::Agent { id, action } => match action {
            AgentAction::ForceRescan { timeout } => commands::agent::force_rescan(&id, timeout),
            AgentAction::Update { check, timeout } => commands::agent::update(&id, check, timeout),
            AgentAction::Caps { action } => match action {
                CapsAction::Get { timeout } => commands::agent::caps_get(&id, timeout),
                CapsAction::Set { json, timeout } => commands::agent::caps_set(&id, &json, timeout),
                CapsAction::Delete { name, timeout } => {
                    commands::agent::caps_delete(&id, &name, timeout)
                }
            },
            AgentAction::Ollama { action } => match action {
                OllamaAction::List { timeout } => commands::agent::ollama_list(&id, timeout),
                OllamaAction::Pull { model, timeout } => {
                    commands::agent::ollama_pull(&id, &model, timeout)
                }
                OllamaAction::Delete { model, timeout } => {
                    commands::agent::ollama_delete(&id, &model, timeout)
                }
            },
            AgentAction::Onnx { action } => match action {
                OnnxAction::List { timeout } => commands::agent::onnx_list(&id, timeout),
                OnnxAction::Prepare { model, timeout } => {
                    commands::agent::onnx_prepare(&id, &model, timeout)
                }
                OnnxAction::Delete { model, timeout } => {
                    commands::agent::onnx_delete(&id, &model, timeout)
                }
            },
            AgentAction::Comfy { action } => match action {
                ComfyAction::Start { timeout } => commands::agent::comfy(&id, "start", timeout),
                ComfyAction::Stop { timeout } => commands::agent::comfy(&id, "stop", timeout),
                ComfyAction::Restart { timeout } => commands::agent::comfy(&id, "restart", timeout),
                ComfyAction::Status { timeout } => commands::agent::comfy(&id, "status", timeout),
            },
        },
        Command::Status { task_limit } => commands::status::run(task_limit),
        Command::Logs { target } => match target {
            LogsTarget::Agent {
                agent,
                severity,
                limit,
            } => commands::logs::agent(agent.as_deref(), &severity, limit),
            LogsTarget::Pod {
                component,
                tail_lines,
                container,
                previous,
                timestamps,
            } => commands::logs::pod(
                &component,
                tail_lines,
                container.as_deref(),
                previous,
                timestamps,
            ),
        },
        Command::Heuristics { target } => match target {
            HeuristicsTarget::Records {
                capability,
                runner_id,
                machine_id,
                limit,
                cursor,
            } => commands::heuristics::records(
                capability.as_deref(),
                runner_id.as_deref(),
                machine_id.as_deref(),
                limit,
                cursor.as_deref(),
            ),
            HeuristicsTarget::Runners => commands::heuristics::runners(),
            HeuristicsTarget::Machines => commands::heuristics::machines(),
        },
        Command::Storage { target } => match target {
            StorageTarget::List => commands::storage::list(),
            StorageTarget::Quotas { api_key } => commands::storage::quotas(api_key.as_deref()),
            StorageTarget::Delete { bucket_uid, yes } => {
                commands::storage::delete(&bucket_uid, yes)
            }
            StorageTarget::DeleteKey { api_key, yes } => {
                commands::storage::delete_key(&api_key, yes)
            }
            StorageTarget::Purge { yes } => commands::storage::purge(yes),
        },
        Command::Cancel { target } => match target {
            CancelTarget::Task { cap, id, yes } => commands::task::cancel(&cap, &id, yes),
        },
        Command::Reset { target } => match target {
            ResetTarget::Tasks { yes } => commands::task::reset(yes),
        },
    };

    if let Err(e) = result {
        eprintln!("{} {e:#}", "error:".red().bold());
        std::process::exit(1);
    }
}
