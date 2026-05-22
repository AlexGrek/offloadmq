use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection, EntityTrait};

use crate::{
    db::entities::app_settings::{self, ActiveModel, Entity},
    error::AppError,
};

pub type AppSettings = app_settings::Model;

pub async fn get(db: &DatabaseConnection) -> Result<AppSettings, AppError> {
    Entity::find_by_id(1)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::Internal("app_settings row missing".into()))
}

pub async fn update(
    db: &DatabaseConnection,
    offloadmq_url: String,
    client_api_token: Option<String>,
    management_api_token: Option<String>,
) -> Result<AppSettings, AppError> {
    let settings = get(db).await?;
    let mut active: ActiveModel = settings.into();
    active.offloadmq_url = ActiveValue::Set(offloadmq_url);
    active.client_api_token = ActiveValue::Set(client_api_token);
    active.management_api_token = ActiveValue::Set(management_api_token);
    active.update(db).await.map_err(AppError::Database)
}
