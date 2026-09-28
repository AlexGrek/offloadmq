use anyhow::{Result, bail};
use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
use owo_colors::OwoColorize;

use crate::models::Agent;

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
