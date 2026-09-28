use anyhow::Result;

use crate::client::Client;
use crate::config::Config;
use crate::output;

pub fn agent(id: &str) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let agents = client.list_agents(false)?;
    let agent = output::resolve_agent(&agents, id)?;
    output::print_agent_detail(agent);
    Ok(())
}
