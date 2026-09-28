use std::collections::HashMap;

use anyhow::{Result, bail};
use chrono::Utc;
use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
use owo_colors::OwoColorize;
use serde_json::Value;

use crate::models::{Agent, QuotaUsage, RunnerStat, StorageQuotas, TaskSummary, TasksOverview};

fn online_cell(online: bool) -> Cell {
    if online {
        Cell::new("online").fg(Color::Green)
    } else {
        Cell::new("offline").fg(Color::DarkGrey)
    }
}

pub fn print_agents_table(agents: &[Agent]) {
    if agents.is_empty() {
        println!("{}", "No agents found.".yellow());
        return;
    }

    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(vec![
            "SHORT ID",
            "NAME",
            "STATUS",
            "TIER",
            "CAP.",
            "LOAD",
            "CAPABILITIES",
            "LAST CONTACT",
        ]);

    for agent in agents {
        let last_contact = agent
            .last_contact
            .map(|t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "never".to_string());
        let caps = if agent.capabilities.is_empty() {
            "-".to_string()
        } else {
            agent.capabilities.join(", ")
        };
        table.add_row(vec![
            Cell::new(&agent.uid_short),
            Cell::new(agent.display_name.as_deref().unwrap_or("-")),
            online_cell(agent.is_online()),
            Cell::new(agent.tier),
            Cell::new(agent.capacity),
            Cell::new(agent.in_flight.unwrap_or(0)),
            Cell::new(caps),
            Cell::new(last_contact),
        ]);
    }

    println!("{table}");
    println!("{}", format!("{} agent(s)", agents.len()).dimmed());
}

pub fn print_capabilities(caps: &[String]) {
    if caps.is_empty() {
        println!("{}", "No online capabilities found.".yellow());
        return;
    }
    let mut sorted = caps.to_vec();
    sorted.sort();
    for cap in &sorted {
        println!("{}", cap.cyan());
    }
    println!("{}", format!("{} capability(ies)", sorted.len()).dimmed());
}

pub fn print_agent_detail(agent: &Agent) {
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);

    let mut row = |k: &str, v: String| {
        table.add_row(vec![Cell::new(k).fg(Color::Blue), Cell::new(v)]);
    };

    row("UID", agent.uid.clone());
    row("Short ID", agent.uid_short.clone());
    row(
        "Display name",
        agent.display_name.clone().unwrap_or_else(|| "-".into()),
    );
    row(
        "Status",
        if agent.is_online() {
            "online".green().to_string()
        } else {
            "offline".dimmed().to_string()
        },
    );
    row(
        "Connected (ws)",
        agent
            .connected
            .map(|c| c.to_string())
            .unwrap_or_else(|| "unknown".into()),
    );
    row(
        "Registered at",
        agent.registered_at.format("%Y-%m-%d %H:%M:%S UTC").to_string(),
    );
    row(
        "Last contact",
        agent
            .last_contact
            .map(|t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "never".into()),
    );
    row(
        "Last comm. method",
        agent.last_comm_method.clone().unwrap_or_else(|| "-".into()),
    );
    row("Tier", agent.tier.to_string());
    row("Capacity", agent.capacity.to_string());
    row("In flight", agent.in_flight.unwrap_or(0).to_string());
    row(
        "App version",
        agent.app_version.clone().unwrap_or_else(|| "-".into()),
    );
    row(
        "Capabilities",
        if agent.capabilities.is_empty() {
            "-".into()
        } else {
            agent.capabilities.join("\n")
        },
    );

    if let Some(info) = &agent.system_info {
        row("OS", info.os.clone());
        row("Client", info.client.clone());
        row("Runtime", info.runtime.clone());
        row("CPU arch", info.cpu_arch.clone());
        row(
            "CPU model",
            info.cpu_model.clone().unwrap_or_else(|| "-".into()),
        );
        row("Total memory (GB)", info.total_memory_gb.to_string());
        row(
            "Machine fingerprint",
            info.machine_id.clone().unwrap_or_else(|| "-".into()),
        );
        if let Some(gpu) = &info.gpu {
            row("GPU", format!("{} {} ({} GB VRAM)", gpu.vendor, gpu.model, gpu.vram_gb));
        }
    }

    println!("{table}");
}

/// Compact "Ns" / "NmNs" / "NhNm" / "Nd" age string for a past timestamp.
fn humanize_age(t: chrono::DateTime<Utc>) -> String {
    let secs = (Utc::now() - t).num_seconds().max(0);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{}s", secs / 60, secs % 60)
    } else if secs < 86400 {
        format!("{}h{}m", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}d", secs / 86400)
    }
}

/// `omqcli status` — section 1: online agents with tech info and an
/// aggregate success rate computed by summing per-capability heuristics
/// (`RunnerStat`) across every capability for each agent's uid.
pub fn print_status_agents(agents: &[Agent], stats: &[RunnerStat]) {
    let online: Vec<&Agent> = agents.iter().filter(|a| a.is_online()).collect();
    println!("{}", format!("Online agents ({})", online.len()).bold());
    if online.is_empty() {
        println!("{}", "  none".dimmed());
        return;
    }

    let mut totals: HashMap<&str, (u64, u64)> = HashMap::new();
    for s in stats {
        let entry = totals.entry(s.runner_id.as_str()).or_default();
        entry.0 += s.total_runs;
        entry.1 += s.success_count;
    }

    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(vec![
            "SHORT ID",
            "NAME",
            "TIER",
            "CAP.",
            "LOAD",
            "OS",
            "CPU",
            "GPU",
            "MEM (GB)",
            "APP VERSION",
            "SUCCESS RATE",
        ]);

    for agent in &online {
        let (os, cpu, gpu, mem) = match &agent.system_info {
            Some(info) => (
                info.os.clone(),
                info.cpu_model.clone().unwrap_or_else(|| info.cpu_arch.clone()),
                info.gpu
                    .as_ref()
                    .map(|g| format!("{} {}", g.vendor, g.model))
                    .unwrap_or_else(|| "-".into()),
                info.total_memory_gb.to_string(),
            ),
            None => ("-".into(), "-".into(), "-".into(), "-".into()),
        };
        let success = match totals.get(agent.uid.as_str()) {
            Some((total, success)) if *total > 0 => {
                format!("{:.1}% ({total})", *success as f64 / *total as f64 * 100.0)
            }
            _ => "-".to_string(),
        };

        table.add_row(vec![
            Cell::new(&agent.uid_short),
            Cell::new(agent.display_name.as_deref().unwrap_or("-")),
            Cell::new(agent.tier),
            Cell::new(agent.capacity),
            Cell::new(agent.in_flight.unwrap_or(0)),
            Cell::new(os),
            Cell::new(cpu),
            Cell::new(gpu),
            Cell::new(mem),
            Cell::new(agent.app_version.as_deref().unwrap_or("-")),
            Cell::new(success),
        ]);
    }
    println!("{table}");
}

/// `omqcli status` — section 2: up to `limit` running and `limit` scheduled
/// tasks, oldest first (longest-running / longest-waiting surfaces first).
pub fn print_status_tasks(tasks: &TasksOverview, agents: &[Agent], limit: usize) {
    let agent_names: HashMap<&str, &str> = agents
        .iter()
        .map(|a| (a.uid.as_str(), a.uid_short.as_str()))
        .collect();

    let mut running: Vec<&TaskSummary> = tasks
        .urgent
        .assigned
        .iter()
        .chain(tasks.regular.assigned.iter())
        .collect();
    running.sort_by_key(|t| t.created_at);

    let mut scheduled: Vec<&TaskSummary> = tasks
        .urgent
        .unassigned
        .iter()
        .chain(tasks.regular.unassigned.iter())
        .collect();
    scheduled.sort_by_key(|t| t.created_at);

    println!();
    println!("{}", format!("Running tasks ({})", running.len()).bold());
    if running.is_empty() {
        println!("{}", "  none".dimmed());
    } else {
        for t in running.iter().take(limit) {
            let agent = t
                .agent_id
                .as_deref()
                .and_then(|id| agent_names.get(id))
                .copied()
                .unwrap_or("?");
            let status = t.status.as_deref().unwrap_or("running");
            let stage = t.stage.as_deref().map(|s| format!(" [{s}]")).unwrap_or_default();
            println!(
                "  {}[{}] on {} — {}{} ({} ago)",
                t.id.cap.cyan(),
                t.id.id.dimmed(),
                agent,
                status,
                stage,
                humanize_age(t.created_at)
            );
        }
        if running.len() > limit {
            println!("  {}", format!("... and {} more", running.len() - limit).dimmed());
        }
    }

    println!();
    println!("{}", format!("Scheduled tasks ({})", scheduled.len()).bold());
    if scheduled.is_empty() {
        println!("{}", "  none".dimmed());
    } else {
        for t in scheduled.iter().take(limit) {
            println!(
                "  {}[{}] waiting ({} ago)",
                t.id.cap.cyan(),
                t.id.id.dimmed(),
                humanize_age(t.created_at)
            );
        }
        if scheduled.len() > limit {
            println!(
                "  {}",
                format!("... and {} more", scheduled.len() - limit).dimmed()
            );
        }
    }
}

/// `omqcli status` — section 3: bucket count vs. the global max-per-key quota
/// for every API key that currently owns at least one bucket.
pub fn print_status_buckets(quotas: &StorageQuotas) {
    println!();
    println!("{}", "Storage buckets".bold());
    let max = quotas.limits.max_buckets_per_key;
    if quotas.usage.is_empty() {
        println!(
            "{}",
            format!("  no buckets in use (max {max} per API key)").dimmed()
        );
        return;
    }

    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(vec!["API KEY", "BUCKETS", "MAX"]);

    let mut rows: Vec<(&String, &QuotaUsage)> = quotas.usage.iter().collect();
    rows.sort_by_key(|(_, usage)| std::cmp::Reverse(usage.bucket_count));
    for (key, usage) in rows {
        table.add_row(vec![Cell::new(key), Cell::new(usage.bucket_count), Cell::new(max)]);
    }
    println!("{table}");
}

/// `omqcli status` — section 4: all capabilities currently provided by
/// online agents.
pub fn print_status_capabilities(caps: &[String]) {
    println!();
    let mut sorted = caps.to_vec();
    sorted.sort();
    println!("{}", format!("Available capabilities ({})", sorted.len()).bold());
    if sorted.is_empty() {
        println!("{}", "  none".dimmed());
    } else {
        println!("  {}", sorted.join(", "));
    }
}

/// `omqcli list tasks` — every task across all four buckets (urgent/regular ×
/// assigned/unassigned), one table per non-empty bucket. `unassigned_only`
/// mirrors the management UI's "Unassigned only" toggle; `cap_filter`
/// restricts to one capability (not present in the UI, added for convenience).
pub fn print_tasks_table(
    tasks: &TasksOverview,
    agents: &[Agent],
    unassigned_only: bool,
    cap_filter: Option<&str>,
) {
    let agent_names: HashMap<&str, String> = agents
        .iter()
        .map(|a| {
            (
                a.uid.as_str(),
                format!("{} ({})", a.uid_short, a.display_name.as_deref().unwrap_or("unnamed")),
            )
        })
        .collect();

    let groups: [(&str, &str, &Vec<TaskSummary>); 4] = [
        ("urgent", "assigned", &tasks.urgent.assigned),
        ("urgent", "unassigned", &tasks.urgent.unassigned),
        ("regular", "assigned", &tasks.regular.assigned),
        ("regular", "unassigned", &tasks.regular.unassigned),
    ];

    let mut printed_any = false;
    for (queue, bucket, list) in groups {
        if unassigned_only && bucket == "assigned" {
            continue;
        }
        let filtered: Vec<&TaskSummary> = list
            .iter()
            .filter(|t| cap_filter.is_none_or(|c| t.id.cap == c))
            .collect();
        if filtered.is_empty() {
            continue;
        }
        printed_any = true;

        println!("{}", format!("{queue} / {bucket} ({})", filtered.len()).bold());
        let mut table = Table::new();
        table
            .load_preset(UTF8_FULL)
            .set_content_arrangement(ContentArrangement::Dynamic)
            .set_header(vec!["TASK ID", "CAPABILITY", "STATUS", "STAGE", "AGENT", "FLAGS", "CREATED"]);

        for t in &filtered {
            let status = t
                .status
                .clone()
                .unwrap_or_else(|| if bucket == "assigned" { "assigned".into() } else { "queued".into() });
            let agent = t
                .agent_id
                .as_deref()
                .and_then(|id| agent_names.get(id))
                .cloned()
                .unwrap_or_else(|| "-".into());
            let flags = t
                .data
                .as_ref()
                .map(|d| {
                    let mut f = vec![];
                    if d.urgent {
                        f.push("urgent");
                    }
                    if d.restartable {
                        f.push("restartable");
                    }
                    f.join(",")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "-".into());

            table.add_row(vec![
                Cell::new(&t.id.id),
                Cell::new(&t.id.cap),
                Cell::new(status),
                Cell::new(t.stage.as_deref().unwrap_or("-")),
                Cell::new(agent),
                Cell::new(flags),
                Cell::new(t.created_at.format("%Y-%m-%d %H:%M:%S UTC").to_string()),
            ]);
        }
        println!("{table}");
        println!();
    }

    if !printed_any {
        println!("{}", "No tasks found.".yellow());
    }
}

/// `omqcli describe task` — full detail for one task: metadata, payload,
/// result, log, and history, mirroring the management UI's expanded task card.
pub fn print_task_detail(queue: &str, assigned: bool, task: &TaskSummary, agents: &[Agent]) {
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);

    let mut row = |k: &str, v: String| {
        table.add_row(vec![Cell::new(k).fg(Color::Blue), Cell::new(v)]);
    };

    row("Task ID", task.id.id.clone());
    row("Capability", task.id.cap.clone());
    row(
        "Queue",
        format!("{queue} ({})", if assigned { "assigned" } else { "unassigned" }),
    );
    row(
        "Status",
        task.status
            .clone()
            .unwrap_or_else(|| if assigned { "assigned".into() } else { "queued".into() }),
    );
    if let Some(stage) = &task.stage {
        row("Stage", stage.clone());
    }
    row("Created", task.created_at.format("%Y-%m-%d %H:%M:%S UTC").to_string());
    if let Some(assigned_at) = task.assigned_at {
        row("Assigned at", assigned_at.format("%Y-%m-%d %H:%M:%S UTC").to_string());
    }
    if let Some(agent_id) = &task.agent_id {
        let name = agents
            .iter()
            .find(|a| &a.uid == agent_id)
            .map(|a| format!("{} ({})", a.uid_short, a.display_name.as_deref().unwrap_or("unnamed")))
            .unwrap_or_else(|| agent_id.clone());
        row("Agent", name);
    }
    if let Some(data) = &task.data {
        let mut flags = vec![];
        if data.urgent {
            flags.push("urgent");
        }
        if data.restartable {
            flags.push("restartable");
        }
        row("Flags", if flags.is_empty() { "-".into() } else { flags.join(", ") });
    }
    println!("{table}");

    if let Some(payload) = task.data.as_ref().and_then(|d| d.payload.as_ref())
        && !payload.is_null()
    {
        println!();
        println!("{}", "Payload:".bold());
        println!(
            "{}",
            serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string())
        );
    }
    if let Some(result) = &task.result
        && !result.is_null()
    {
        println!();
        println!("{}", "Result:".bold());
        println!(
            "{}",
            serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
        );
    }
    if let Some(log) = &task.log
        && !log.is_empty()
    {
        println!();
        println!("{}", "Log:".bold());
        println!("{log}");
    }
    if !task.history.is_empty() {
        println!();
        println!("{}", "History:".bold());
        for h in &task.history {
            println!(
                "  {} {}",
                h.timestamp.format("%Y-%m-%d %H:%M:%S UTC").to_string().dimmed(),
                h.description
            );
        }
    }
}

/// Print the result of a `slavemode.*` task: the server's response shape
/// varies (a full assigned-task record on success, a short `{id, status,
/// message}` record on server-side expiry), so pull out the fields we care
/// about defensively rather than assuming one exact struct.
///
/// Returns `Err` if the task's terminal status was not `completed`, so
/// callers can propagate a non-zero exit code.
pub fn print_slavemode_result(capability: &str, raw: &Value) -> Result<()> {
    let status = raw
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let result = raw.get("result").or_else(|| raw.get("output"));
    let log = raw.get("log").and_then(|v| v.as_str());
    let message = raw.get("message").and_then(|v| v.as_str());

    let ok = status == "completed";
    let label = if ok {
        status.green().bold().to_string()
    } else {
        status.red().bold().to_string()
    };
    println!("{} {} {}", capability.cyan(), "→".dimmed(), label);

    if let Some(msg) = message {
        println!("{msg}");
    }
    if let Some(result) = result
        && !result.is_null()
    {
        println!(
            "{}",
            serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
        );
    }
    if let Some(log) = log
        && !log.is_empty()
    {
        println!("{}", "log:".dimmed());
        println!("{log}");
    }

    if !ok {
        let reason = message
            .or_else(|| result.and_then(|r| r.as_str()))
            .unwrap_or("task did not complete successfully");
        bail!("{reason}");
    }
    Ok(())
}

/// Resolve a user-supplied identifier (full uid, short id, display name, or
/// machine fingerprint) to exactly one agent, erroring with the candidate
/// list if the match is missing or ambiguous.
pub fn resolve_agent<'a>(agents: &'a [Agent], needle: &str) -> Result<&'a Agent> {
    let mut matches: Vec<&Agent> = agents.iter().filter(|a| a.matches(needle)).collect();

    // Prefer an exact full-uid match over suffix/display-name matches.
    if let Some(exact) = matches.iter().find(|a| a.uid == needle) {
        return Ok(exact);
    }

    if matches.is_empty() {
        bail!("no agent found matching {needle:?}");
    }
    if matches.len() > 1 {
        matches.sort_by(|a, b| a.uid_short.cmp(&b.uid_short));
        let candidates: Vec<String> = matches
            .iter()
            .map(|a| {
                format!(
                    "{} ({})",
                    a.uid_short,
                    a.display_name.as_deref().unwrap_or("unnamed")
                )
            })
            .collect();
        bail!(
            "{needle:?} matches {} agents, be more specific: {}",
            matches.len(),
            candidates.join(", ")
        );
    }
    Ok(matches.remove(0))
}
