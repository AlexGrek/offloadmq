use std::collections::HashSet;

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

/// All stored imggen models for the picker: online first, then by most recent availability.
pub async fn list_for_display(
    db: &DatabaseConnection,
    online_bases: &HashSet<String>,
) -> Result<Vec<LlmCapabilityInfo>, AppError> {
    let mut rows: Vec<Model> = Entity::find().all(db).await.map_err(AppError::Database)?;
    rows.sort_by(|a, b| {
        let a_on = online_bases.contains(&a.base);
        let b_on = online_bases.contains(&b.base);
        match (a_on, b_on) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) | (false, false) => b
                .last_available_at
                .cmp(&a.last_available_at)
                .then_with(|| a.base.cmp(&b.base)),
        }
    });
    rows.into_iter()
        .map(|row| {
            let online = online_bases.contains(&row.base);
            row_to_info(row, online)
        })
        .collect()
}

fn row_to_info(row: Model, online: bool) -> Result<LlmCapabilityInfo, AppError> {
    let tags: Vec<String> =
        serde_json::from_str(&row.tags_json).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(LlmCapabilityInfo {
        base: row.base,
        tags,
        raw: row.raw,
        online,
        last_available_at: row.last_available_at.to_rfc3339(),
    })
}
