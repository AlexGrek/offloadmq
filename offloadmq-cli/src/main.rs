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
    /// List agents or online capabilities
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
}

#[derive(Subcommand)]
enum DescribeTarget {
    /// Show details for one agent (full uid, short id, display name, or fingerprint)
    Agent {
        /// Agent id, short id, display name, or machine fingerprint
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

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Command::Auth { key, server } => commands::auth::run(key, server),
        Command::List { target } => match target {
            ListTarget::Agents { online } => commands::list::agents(online),
            ListTarget::Caps { ext } => commands::list::capabilities(ext),
        },
        Command::Describe { target } => match target {
            DescribeTarget::Agent { id } => commands::describe::agent(&id),
        },
        Command::Delete { target } => match target {
            DeleteTarget::Agent { id, yes } => commands::delete::agent(&id, yes),
        },
    };

    if let Err(e) = result {
        eprintln!("{} {e:#}", "error:".red().bold());
        std::process::exit(1);
    }
}
