use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
};

use crate::{
    db::entities::users::{self, ActiveModel, Column, Entity},
    error::AppError,
};

pub type User = users::Model;

pub async fn find_by_id(db: &DatabaseConnection, id: i64) -> Result<Option<User>, AppError> {
    Entity::find_by_id(id).one(db).await.map_err(AppError::Database)
}

pub async fn find_by_login(db: &DatabaseConnection, login: &str) -> Result<Option<User>, AppError> {
    Entity::find()
        .filter(Column::Login.eq(login))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn create(
    db: &DatabaseConnection,
    id: i64,
    login: &str,
    password_hash: Option<String>,
    google_id: Option<String>,
) -> Result<User, AppError> {
    let model = ActiveModel {
        id: ActiveValue::Set(id),
        login: ActiveValue::Set(login.to_string()),
        password_hash: ActiveValue::Set(password_hash),
        google_id: ActiveValue::Set(google_id),
        created_at: ActiveValue::Set(Utc::now().into()),
        last_quotas_update_timestamp: ActiveValue::Set(None),
        is_admin: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn create_admin(
    db: &DatabaseConnection,
    id: i64,
    login: &str,
    password_hash: String,
) -> Result<User, AppError> {
    let model = ActiveModel {
        id: ActiveValue::Set(id),
        login: ActiveValue::Set(login.to_string()),
        password_hash: ActiveValue::Set(Some(password_hash)),
        google_id: ActiveValue::Set(None),
        created_at: ActiveValue::Set(Utc::now().into()),
        last_quotas_update_timestamp: ActiveValue::Set(None),
        is_admin: ActiveValue::Set(Some(true)),
    };
    model.insert(db).await.map_err(AppError::Database)
}
