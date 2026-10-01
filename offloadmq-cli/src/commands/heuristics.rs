use anyhow::{Result, bail};

use crate::client::Client;
use crate::config::Config;
use crate::output;

pub fn records(
    capability: Option<&str>,
    runner_id: Option<&str>,
    machine_id: Option<&str>,
    limit: usize,
    cursor: Option<&str>,
) -> Result<()> {
    if !(1..=500).contains(&limit) {
        bail!("--limit must be between 1 and 500");
    }
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let page = client.heuristic_records(capability, runner_id, machine_id, limit, cursor)?;
    output::print_heuristic_records(&page.items, page.next_cursor.as_deref());
    Ok(())
}

pub fn runners() -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    output::print_heuristic_stats(&client.heuristic_runner_stats()?, "RUNNER ID");
    Ok(())
}

pub fn machines() -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    output::print_heuristic_machine_stats(&client.heuristic_machine_stats()?);
    Ok(())
}
