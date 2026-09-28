use anyhow::Result;
use owo_colors::OwoColorize;

use crate::client::Client;
use crate::config::{Config, require_valid_url};

pub fn run(key: String, server: Option<String>) -> Result<()> {
    let mut cfg = Config::load()?;
    if let Some(server) = &server {
        require_valid_url(server)?;
        cfg.server = Some(server.clone());
    }
    cfg.key = Some(key);
    cfg.save()?;

    let (server, key) = cfg.require()?;
    println!("Saved credentials to {}", Config::path()?.display());

    match Client::new(&server, &key).and_then(|c| c.server_version()) {
        Ok(v) => println!(
            "{} connected to {server} (server version {v})",
            "OK".green().bold()
        ),
        Err(e) => println!(
            "{} saved key, but could not verify it against {server}: {e}",
            "WARN".yellow().bold()
        ),
    }
    Ok(())
}
