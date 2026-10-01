use std::io::{self, Write};

use anyhow::Result;
use owo_colors::OwoColorize;

use crate::client::Client;
use crate::config::Config;
use crate::output;

fn confirm(prompt: &str) -> Result<bool> {
    print!("{prompt} [y/N] ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

pub fn list() -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    let buckets = client.storage_buckets()?;
    let quotas = client.storage_quotas()?;
    output::print_storage_buckets(&buckets, &quotas);
    Ok(())
}

pub fn quotas(api_key: Option<&str>) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    output::print_storage_quotas(&client.storage_quotas_for_key(api_key)?);
    Ok(())
}

pub fn delete(bucket_uid: &str, yes: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    if !yes && !confirm(&format!("Delete bucket {bucket_uid} and all of its files?"))? {
        println!("Aborted.");
        return Ok(());
    }
    let raw = client.delete_storage_bucket(bucket_uid)?;
    let deleted = raw
        .get("deleted_bucket_uid")
        .and_then(|v| v.as_str())
        .unwrap_or(bucket_uid);
    println!("{} deleted bucket {deleted}", "OK".green().bold());
    Ok(())
}

pub fn delete_key(api_key: &str, yes: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    if !yes
        && !confirm(&format!(
            "Delete every bucket and file owned by API key {api_key}?"
        ))?
    {
        println!("Aborted.");
        return Ok(());
    }
    let raw = client.delete_storage_key_buckets(api_key)?;
    let deleted = raw
        .get("deleted_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    println!(
        "{} deleted {deleted} bucket(s) for {api_key}",
        "OK".green().bold()
    );
    Ok(())
}

pub fn purge(yes: bool) -> Result<()> {
    let cfg = Config::load()?;
    let (server, key) = cfg.require()?;
    let client = Client::new(&server, &key)?;
    if !yes {
        println!(
            "{}",
            "This permanently deletes EVERY bucket and staged file for EVERY API key.".red()
        );
        if !confirm("Continue?")? {
            println!("Aborted.");
            return Ok(());
        }
    }
    let raw = client.purge_storage_buckets()?;
    let deleted = raw
        .get("deleted_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    println!("{} deleted {deleted} bucket(s)", "OK".green().bold());
    Ok(())
}
