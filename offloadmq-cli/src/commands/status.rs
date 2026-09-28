use anyhow::Result;
use owo_colors::OwoColorize;

use crate::client::Client;
use crate::config::Config;
use crate::output;

/// `omqcli status` — a one-shot dashboard: online agents (+ success rate),
/// up to `task_limit` running/scheduled tasks, bucket usage per API key
/// against the global quota, and every capability currently online.
pub fn run(task_limit: usize) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;

    println!("{}", format!("OffloadMQ status — {server}").bold().underline());
    println!();

    let agents = client.list_agents(false)?;
    let stats = client.runner_stats()?;
    output::print_status_agents(&agents, &stats);

    let tasks = client.list_tasks()?;
    output::print_status_tasks(&tasks, &agents, task_limit);

    let quotas = client.storage_quotas()?;
    output::print_status_buckets(&quotas);

    let caps = client.list_capabilities(false)?;
    output::print_status_capabilities(&caps);

    Ok(())
}
