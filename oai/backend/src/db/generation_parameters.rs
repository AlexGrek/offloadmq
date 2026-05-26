//! Generation parameters table — append-only record of what each generated
//! file (image or audio) was produced from. **Never bulk-cleaned**: even after
//! the source file/job is deleted, the parameters row is preserved so the user
//! can re-discover how a download was made.

use sea_orm::{
    sea_query::OnConflict, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter,
};

use crate::{
    db::entities::generation_parameters::{self, Entity as GenerationParametersEntity},
    error::AppError,
};

pub type GenerationParameters = generation_parameters::Model;

pub struct UpsertInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub filename: &'a str,
    /// `"image"` or `"audio"`.
    pub source: &'a str,
    pub parameters: serde_json::Value,
}

/// Insert or replace the parameters row for `(user_id, filename)`. The row is
/// keyed by filename — re-running a job that produces the same filename
/// updates the parameters, but rows for files that have since been deleted
/// remain in the table.
pub async fn upsert(
    db: &DatabaseConnection,
    input: UpsertInput<'_>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = generation_parameters::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        filename: ActiveValue::Set(input.filename.to_string()),
        source: ActiveValue::Set(input.source.to_string()),
        parameters: ActiveValue::Set(input.parameters),
        created_at: ActiveValue::Set(now),
    };
    GenerationParametersEntity::insert(model)
        .on_conflict(
            OnConflict::columns([
                generation_parameters::Column::UserId,
                generation_parameters::Column::Filename,
            ])
            .update_columns([
                generation_parameters::Column::Source,
                generation_parameters::Column::Parameters,
            ])
            .to_owned(),
        )
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

pub async fn get_by_filename(
    db: &DatabaseConnection,
    user_id: i64,
    filename: &str,
) -> Result<Option<GenerationParameters>, AppError> {
    GenerationParametersEntity::find()
        .filter(generation_parameters::Column::UserId.eq(user_id))
        .filter(generation_parameters::Column::Filename.eq(filename))
        .one(db)
        .await
        .map_err(AppError::Database)
}
