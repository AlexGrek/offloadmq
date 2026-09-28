use std::io::{self, Write};

use anyhow::Result;
use owo_colors::OwoColorize;

use crate::client::Client;
use crate::config::Config;
use crate::models::{TaskSummary, TasksOverview};
use crate::output;

/// Find one task by (cap, id) across all four buckets and report which queue/
/// bucket it lives in — there's no server-side get-by-id, only the full list.
fn find_task<'a>(tasks: &'a TasksOverview, cap: &str, id: &str) -> Option<(&'static str, bool, &'a TaskSummary)> {
    let buckets: [(&'static str, bool, &Vec<TaskSummary>); 4] = [
        ("urgent", true, &tasks.urgent.assigned),
        ("urgent", false, &tasks.urgent.unassigned),
        ("regular", true, &tasks.regular.assigned),
        ("regular", false, &tasks.regular.unassigned),
    ];
    for (queue, assigned, list) in buckets {
        if let Some(t) = list.iter().find(|t| t.id.cap == cap && t.id.id == id) {
            return Some((queue, assigned, t));
        }
    }
    None
}

fn confirm(prompt: &str) -> Result<bool> {
    print!("{prompt} [y/N] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

pub fn list(unassigned_only: bool, cap: Option<String>) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let tasks = client.list_tasks()?;
    let agents = client.list_agents(false)?;
    output::print_tasks_table(&tasks, &agents, unassigned_only, cap.as_deref());
    Ok(())
}

pub fn describe(cap: &str, id: &str) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let tasks = client.list_tasks()?;
    let agents = client.list_agents(false)?;

    let (queue, assigned, task) = find_task(&tasks, cap, id).ok_or_else(|| {
        anyhow::anyhow!(
            "no task found with capability {cap:?} and id {id:?} — it may already be \
             archived/expired, or never existed"
        )
    })?;
    output::print_task_detail(queue, assigned, task, &agents);
    Ok(())
}

pub fn cancel(cap: &str, id: &str, yes: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;

    if !yes && !confirm(&format!("Cancel task {cap}[{id}]?"))? {
        println!("Aborted.");
        return Ok(());
    }

    let raw = client.cancel_task(cap, id)?;
    let status = raw.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
    let message = raw.get("message").and_then(|v| v.as_str()).unwrap_or("");
    println!("{} {cap}[{id}] → {} {message}", "OK".green().bold(), status.yellow());
    Ok(())
}

pub fn reset(yes: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;

    if !yes {
        println!(
            "{}",
            "This permanently clears EVERY task — urgent and regular, queued and running.".red()
        );
        if !confirm("Continue?")? {
            println!("Aborted.");
            return Ok(());
        }
    }

    client.reset_tasks()?;
    println!("{} all tasks reset", "OK".green().bold());
    Ok(())
}

