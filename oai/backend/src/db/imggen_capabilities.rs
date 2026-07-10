use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue, DatabaseConnection, EntityTrait, Set,
};

use crate::{
    db::entities::imggen_capabilities::{ActiveModel, Entity, Model},
    error::AppError,
    offload::LlmCapabilityInfo,
};

pub async fn sync_online(
    db: &DatabaseConnection,
    online: &[LlmCapabilityInfo],
) -> Result<(), AppError> {
    let now = Utc::now().fixed_offset();
    for cap in online {
        let tags_json =
            serde_json::to_string(&cap.tags).map_err(|e| AppError::Internal(e.to_string()))?;
        let existing = Entity::find_by_id(&cap.base).one(db).await.map_err(AppError::Database)?;
        if let Some(row) = existing {
            let mut active: ActiveModel = row.into();
            active.tags_json = ActiveValue::Set(tags_json);
            active.raw = ActiveValue::Set(cap.raw.clone());
            active.last_available_at = ActiveValue::Set(now);
            active.update(db).await.map_err(AppError::Database)?;
        } else {
            let active = ActiveModel {
                base: Set(cap.base.clone()),
                tags_json: Set(tags_json),
                raw: Set(cap.raw.clone()),
                last_available_at: Set(now),
                created_at: Set(now),
                ..Default::default()
            };
            active.insert(db).await.map_err(AppError::Database)?;
        }
    }
    Ok(())
}

/// All stored imggen models for the picker: online first sorted by usage count
/// (from the caller's recent run history), then offline by most recent availability.
pub async fn list_for_display(
    db: &DatabaseConnection,
    online_bases: &HashSet<String>,
    usage_counts: &HashMap<String, u32>,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let mut rows: Vec<Model> = Entity::find().all(db).await.map_err(AppError::Database)?;
    rows.sort_by(|a, b| {
        let a_on = online_bases.contains(&a.base);
        let b_on = online_bases.contains(&b.base);
        match (a_on, b_on) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => {
                let a_usage = usage_counts.get(&a.base).copied().unwrap_or(0);
                let b_usage = usage_counts.get(&b.base).copied().unwrap_or(0);
                b_usage
                    .cmp(&a_usage)
                    .then_with(|| b.last_available_at.cmp(&a.last_available_at))
                    .then_with(|| a.base.cmp(&b.base))
            }
            (false, false) => b
                .last_available_at
                .cmp(&a.last_available_at)
                .then_with(|| a.base.cmp(&b.base)),
        }
    });
    rows.into_iter()
        .map(|row| {
            let online = online_bases.contains(&row.base);
            let usage_count = usage_counts.get(&row.base).copied().unwrap_or(0);
            row_to_info(row, online, usage_count)
        })
        .collect()
}

fn row_to_info(row: Model, online: bool, usage_count: u32) -> Result<LlmCapabilityInfo, AppError> {
    let tags: Vec<String> =
        serde_json::from_str(&row.tags_json).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(LlmCapabilityInfo {
        base: row.base,
        tags,
        raw: row.raw,
        online,
        last_available_at: row.last_available_at.to_rfc3339(),
        usage_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(base: &str, last_available_at: chrono::DateTime<chrono::FixedOffset>) -> Model {
        Model {
            base: base.to_string(),
            tags_json: "[]".into(),
            raw: base.to_string(),
            last_available_at,
            created_at: last_available_at,
        }
    }

    fn sort(mut rows: Vec<Model>, online: &HashSet<String>, usage: &HashMap<String, u32>) -> Vec<Model> {
        rows.sort_by(|a, b| {
            let a_on = online.contains(&a.base);
            let b_on = online.contains(&b.base);
            match (a_on, b_on) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                (true, true) => {
                    let a_usage = usage.get(&a.base).copied().unwrap_or(0);
                    let b_usage = usage.get(&b.base).copied().unwrap_or(0);
                    b_usage
                        .cmp(&a_usage)
                        .then_with(|| b.last_available_at.cmp(&a.last_available_at))
                        .then_with(|| a.base.cmp(&b.base))
                }
                (false, false) => b
                    .last_available_at
                    .cmp(&a.last_available_at)
                    .then_with(|| a.base.cmp(&b.base)),
            }
        });
        rows
    }

    #[test]
    fn online_models_sorted_by_usage_descending() {
        let now = Utc::now().fixed_offset();
        let online = HashSet::from(["imggen.a".to_string(), "imggen.b".to_string()]);
        let usage = HashMap::from([("imggen.a".to_string(), 1u32), ("imggen.b".to_string(), 5u32)]);
        let rows = vec![row("imggen.a", now), row("imggen.b", now)];
        let sorted = sort(rows, &online, &usage);
        assert_eq!(sorted[0].base, "imggen.b");
        assert_eq!(sorted[1].base, "imggen.a");
    }

    #[test]
    fn unused_online_model_falls_back_to_last_available_at() {
        let now = Utc::now().fixed_offset();
        let earlier = now - chrono::Duration::hours(1);
        let online = HashSet::from(["imggen.a".to_string(), "imggen.b".to_string()]);
        let usage = HashMap::new(); // neither used — usage ties at 0
        let rows = vec![row("imggen.a", earlier), row("imggen.b", now)];
        let sorted = sort(rows, &online, &usage);
        assert_eq!(sorted[0].base, "imggen.b");
        assert_eq!(sorted[1].base, "imggen.a");
    }

    #[test]
    fn offline_models_ignore_usage_and_sort_by_last_available_at() {
        let now = Utc::now().fixed_offset();
        let earlier = now - chrono::Duration::hours(1);
        let online = HashSet::new();
        // Offline model with higher usage should NOT jump ahead of a more recently
        // available offline model — usage only ranks the online group.
        let usage = HashMap::from([("imggen.a".to_string(), 10u32)]);
        let rows = vec![row("imggen.a", earlier), row("imggen.b", now)];
        let sorted = sort(rows, &online, &usage);
        assert_eq!(sorted[0].base, "imggen.b");
        assert_eq!(sorted[1].base, "imggen.a");
    }

    #[test]
    fn online_always_ranks_above_offline_regardless_of_usage() {
        let now = Utc::now().fixed_offset();
        let online = HashSet::from(["imggen.b".to_string()]);
        let usage = HashMap::from([("imggen.a".to_string(), 100u32)]);
        let rows = vec![row("imggen.a", now), row("imggen.b", now)];
        let sorted = sort(rows, &online, &usage);
        assert_eq!(sorted[0].base, "imggen.b");
        assert_eq!(sorted[1].base, "imggen.a");
    }
}
