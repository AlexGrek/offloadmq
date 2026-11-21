use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    services::wikipedia::{self, WikiArticle},
    state::AppState,
};

#[derive(Deserialize)]
pub struct RandomWikiQuery {
    pub lang: Option<String>,
}

/// `GET /api/wiki/random?lang=en` — a random Wikipedia article intro.
pub async fn random_wiki(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_user_id): AuthenticatedUser,
    Query(query): Query<RandomWikiQuery>,
) -> Result<Json<WikiArticle>, AppError> {
    let lang = wikipedia::normalize_lang(query.lang.as_deref())?;
    Ok(Json(wikipedia::random_article(&state.http, &lang).await?))
}
