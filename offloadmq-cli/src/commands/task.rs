use std::io::{self, Write};

use anyhow::Result;
use owo_colors::OwoColorize;

use crate::client::{Client, TaskQuery};
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

/// Warn on stderr when the server cut any list short, so a short table is
/// never mistaken for the whole queue.
fn warn_if_truncated(tasks: &TasksOverview) {
    let meta = &tasks.meta;
    if !meta.truncated {
        return;
    }
    let t = &meta.totals;
    eprintln!(
        "{} lists capped at {} per group — server has urgent {}/{} assigned/queued, \
         regular {}/{} assigned/queued. Narrow with --status active|terminal, or raise \
         --limit (max {}).",
        "note:".yellow().bold(),
        meta.limit,
        t.urgent_assigned,
        t.urgent_unassigned,
        t.regular_assigned,
        t.regular_unassigned,
        TaskQuery::MAX,
    );
}

pub fn list(
    unassigned_only: bool,
    cap: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
    all: bool,
) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let query = if all {
        TaskQuery::everything()
    } else {
        TaskQuery {
            status: status.as_deref().map(|s| match s {
                "active" => "active",
                "terminal" => "terminal",
                _ => "all",
            }),
            limit,
        }
    };
    let tasks = client.list_tasks(query)?;
    let agents = client.list_agents(false)?;
    output::print_tasks_table(&tasks, &agents, unassigned_only, cap.as_deref());
    warn_if_truncated(&tasks);
    Ok(())
}

pub fn describe(cap: &str, id: &str) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let tasks = client.list_tasks(TaskQuery::everything())?;
    let agents = client.list_agents(false)?;

    let (queue, assigned, task) = find_task(&tasks, cap, id).ok_or_else(|| {
        let hint = if tasks.meta.truncated {
            " — the server list is capped, so an older task may be beyond the newest 1000"
        } else {
            ""
        };
        anyhow::anyhow!(
            "no task found with capability {cap:?} and id {id:?} — it may already be \
             archived/expired, or never existed{hint}"
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

