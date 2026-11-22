//! Per-user registry for the prompt "reverse substitutions" feature: words that are
//! never swapped for a `{placeholder}`, and placeholder names never tried at all.

use sea_orm::{ActiveValue::Set, DatabaseConnection, EntityTrait, sea_query::OnConflict};
use serde::{Deserialize, Serialize};

use crate::{
    db::entities::user_reverse_exclusions::{ActiveModel, Column, Entity},
    error::AppError,
};

pub const MAX_ENTRIES: usize = 500;
pub const MAX_WORD_CHARS: usize = 64;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ReverseExclusions {
    /// Words/phrases that must stay literal, e.g. `red`.
    pub words: Vec<String>,
    /// Placeholder names to skip, stored lowercase without braces, e.g. `adjective`.
    pub placeholders: Vec<String>,
}

fn dedupe_case_insensitive(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items.filter(|s| seen.insert(s.to_lowercase())).collect()
}

impl ReverseExclusions {
    /// Trims, drops blanks, de-duplicates case-insensitively and validates sizes.
    pub fn normalize(self) -> Result<Self, AppError> {
        let words = dedupe_case_insensitive(
            self.words
                .iter()
                .map(|w| w.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|w| !w.is_empty()),
        );
        let placeholders = dedupe_case_insensitive(
            self.placeholders
                .iter()
                .map(|p| {
                    p.trim()
                        .trim_start_matches('{')
                        .trim_end_matches('}')
                        .trim()
                        .to_lowercase()
                })
                .filter(|p| !p.is_empty()),
        );
        if words.len() > MAX_ENTRIES || placeholders.len() > MAX_ENTRIES {
            return Err(AppError::BadRequest(format!(
                "At most {MAX_ENTRIES} entries per list"
            )));
        }
        if words.iter().any(|w| w.chars().count() > MAX_WORD_CHARS) {
            return Err(AppError::BadRequest(format!(
                "Words can be at most {MAX_WORD_CHARS} characters"
            )));
        }
        if let Some(bad) = placeholders.iter().find(|p| {
            p.chars().count() > MAX_WORD_CHARS
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '?'))
        }) {
            return Err(AppError::BadRequest(format!(
                "Invalid placeholder name: {bad}"
            )));
        }
        Ok(Self {
            words,
            placeholders,
        })
    }
}

pub async fn get(db: &DatabaseConnection, user_id: i64) -> Result<ReverseExclusions, AppError> {
    Ok(Entity::find_by_id(user_id)
        .one(db)
        .await?
        .map(|m| ReverseExclusions {
            words: serde_json::from_str(&m.words_json).unwrap_or_default(),
            placeholders: serde_json::from_str(&m.placeholders_json).unwrap_or_default(),
        })
        .unwrap_or_default())
}

pub async fn save(
    db: &DatabaseConnection,
    user_id: i64,
    value: ReverseExclusions,
) -> Result<ReverseExclusions, AppError> {
    let value = value.normalize()?;
    Entity::insert(ActiveModel {
        user_id: Set(user_id),
        words_json: Set(
            serde_json::to_string(&value.words).map_err(|e| AppError::Internal(e.to_string()))?
        ),
        placeholders_json: Set(serde_json::to_string(&value.placeholders)
            .map_err(|e| AppError::Internal(e.to_string()))?),
    })
    .on_conflict(
        OnConflict::column(Column::UserId)
            .update_columns([Column::WordsJson, Column::PlaceholdersJson])
            .to_owned(),
    )
    .exec(db)
    .await?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(words: &[&str], placeholders: &[&str]) -> ReverseExclusions {
        ReverseExclusions {
            words: words.iter().map(|s| s.to_string()).collect(),
            placeholders: placeholders.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn normalizes_and_dedupes() {
        let n = make(
            &["  Red ", "red", "", "big   cat"],
            &["{Adjective}", " adjective ", "{ }"],
        )
        .normalize()
        .unwrap();
        assert_eq!(n.words, vec!["Red", "big cat"]);
        assert_eq!(n.placeholders, vec!["adjective"]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(
            make(&[&"x".repeat(MAX_WORD_CHARS + 1)], &[])
                .normalize()
                .is_err()
        );
        assert!(make(&[], &["bad name!"]).normalize().is_err());
        let many: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("w{i}")).collect();
        assert!(
            ReverseExclusions {
                words: many,
                placeholders: vec![]
            }
            .normalize()
            .is_err()
        );
        assert!(make(&[], &["?"]).normalize().is_ok());
    }
}
