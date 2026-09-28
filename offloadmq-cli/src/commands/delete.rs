use std::io::{self, Write};

use anyhow::Result;
use owo_colors::OwoColorize;

use crate::client::Client;
use crate::config::Config;
use crate::output;

pub fn agent(id: &str, yes: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let agents = client.list_agents(false)?;
    let target = output::resolve_agent(&agents, id)?.clone();

    if !yes {
        print!(
            "Delete agent {} ({})? [y/N] ",
            target.uid_short,
            target.display_name.as_deref().unwrap_or("unnamed")
        );
        io::stdout().flush()?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer)?;
        if !matches!(answer.trim().to_lowercase().as_str(), "y" | "yes") {
            println!("Aborted.");
            return Ok(());
        }
    }

    client.delete_agent(&target.uid)?;
    println!(
        "{} deleted agent {} ({})",
        "OK".green().bold(),
        target.uid_short,
        target.uid
    );
    Ok(())
}
