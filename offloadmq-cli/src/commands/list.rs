use anyhow::Result;

use crate::client::Client;
use crate::config::Config;
use crate::output;

pub fn agents(online: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let agents = client.list_agents(online)?;
    output::print_agents_table(&agents);
    Ok(())
}

pub fn capabilities(extended: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let caps = client.list_capabilities(extended)?;
    output::print_capabilities(&caps);
    Ok(())
}
