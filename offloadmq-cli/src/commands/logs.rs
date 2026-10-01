use anyhow::{Result, bail};

use crate::client::Client;
use crate::config::Config;
use crate::output;

pub fn agent(agent_id: Option<&str>, severities: &[String], limit: i64) -> Result<()> {
    if limit == 0 || limit < -1 {
        bail!("--limit must be positive or -1 for all records");
    }

    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let mut records = if let Some(agent_id) = agent_id {
        client.agent_logs_by_agent(agent_id, limit)?
    } else if severities.is_empty() {
        client.agent_logs_latest(limit)?
    } else {
        let mut records = Vec::new();
        for severity in severities {
            records.extend(client.agent_logs_by_severity(severity, limit)?);
        }
        records.sort_by(|a, b| b.record_id.cmp(&a.record_id));
        records.dedup_by(|a, b| a.record_id == b.record_id);
        if limit > 0 {
            records.truncate(limit as usize);
        }
        records
    };

    records.sort_by(|a, b| b.record_id.cmp(&a.record_id));
    output::print_agent_logs(&records);
    Ok(())
}

pub fn pod(
    component: &str,
    tail_lines: u32,
    container: Option<&str>,
    previous: bool,
    timestamps: bool,
) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let status = client.pod_status(component)?;
    let logs = client.pod_logs(component, tail_lines, container, previous, timestamps)?;
    output::print_pod_status(&status);
    output::print_pod_logs(&logs);
    Ok(())
}
