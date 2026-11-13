use sea_orm::{ActiveValue::Set, DatabaseConnection, EntityTrait, sea_query::OnConflict};
use serde::{Deserialize, Serialize};

use crate::{
    db::entities::user_prompt_defaults::{ActiveModel, Column, Entity},
    error::AppError,
};

/// Null (or blank on input) means use the built-in prompt for this app.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PromptDefaults {
    pub describe_image: Option<String>,
    pub chat: Option<String>,
    pub image_cycles: Option<String>,
    pub generator_improver: Option<String>,
    pub prompt_studio_system: Option<String>,
    /// Prompt Studio first-message template; `{prompt}` is the example prompt.
    pub prompt_studio_template: Option<String>,
}

#[derive(Clone, Copy)]
pub enum App {
    DescribeImage,
    Chat,
    ImageCycles,
    GeneratorImprover,
    PromptStudioSystem,
}

impl PromptDefaults {
    pub fn normalize(mut self) -> Result<Self, AppError> {
        for prompt in [
            &mut self.describe_image,
            &mut self.chat,
            &mut self.image_cycles,
            &mut self.generator_improver,
            &mut self.prompt_studio_system,
            &mut self.prompt_studio_template,
        ] {
            *prompt = match prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(text) => Some(super::prompts::normalize_content(text)?),
                None => None,
            };
        }
        Ok(self)
    }

    pub fn resolve(&self, app: App) -> String {
        let (custom, key) = match app {
            App::DescribeImage => (&self.describe_image, "describe_image"),
            App::Chat => (&self.chat, "chat"),
            App::ImageCycles => (&self.image_cycles, "describe_image"),
            App::GeneratorImprover => (&self.generator_improver, "generator_improver"),
            App::PromptStudioSystem => (&self.prompt_studio_system, "prompt_studio_system"),
        };
        if let Some(text) = custom.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return text.to_owned();
        }
        let builtins: serde_json::Value =
            serde_json::from_str(include_str!("../default_prompts.json"))
                .expect("valid built-in prompts");
        builtins[key]
            .as_str()
            .expect("built-in prompt exists")
            .to_owned()
    }
}

pub async fn get(db: &DatabaseConnection, user_id: i64) -> Result<PromptDefaults, AppError> {
    Ok(Entity::find_by_id(user_id)
        .one(db)
        .await?
        .map(|m| PromptDefaults {
            describe_image: m.describe_image,
            chat: m.chat,
            image_cycles: m.image_cycles,
            generator_improver: m.generator_improver,
            prompt_studio_system: m.prompt_studio_system,
            prompt_studio_template: m.prompt_studio_template,
        })
        .unwrap_or_default())
}

pub async fn save(
    db: &DatabaseConnection,
    user_id: i64,
    prompts: PromptDefaults,
) -> Result<PromptDefaults, AppError> {
    let prompts = prompts.normalize()?;
    Entity::insert(ActiveModel {
        user_id: Set(user_id),
        describe_image: Set(prompts.describe_image.clone()),
        chat: Set(prompts.chat.clone()),
        image_cycles: Set(prompts.image_cycles.clone()),
        generator_improver: Set(prompts.generator_improver.clone()),
        prompt_studio_system: Set(prompts.prompt_studio_system.clone()),
        prompt_studio_template: Set(prompts.prompt_studio_template.clone()),
    })
    .on_conflict(
        OnConflict::column(Column::UserId)
            .update_columns([
                Column::DescribeImage,
                Column::Chat,
                Column::ImageCycles,
                Column::GeneratorImprover,
                Column::PromptStudioSystem,
                Column::PromptStudioTemplate,
            ])
            .to_owned(),
    )
    .exec(db)
    .await?;
    Ok(prompts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_independent_and_blank_settings_reset() {
        let settings = PromptDefaults {
            describe_image: Some("  Describe custom  ".into()),
            chat: Some(" \n ".into()),
            image_cycles: Some("Cycles custom".into()),
            generator_improver: Some("Improver custom".into()),
            prompt_studio_system: Some("  Studio custom ".into()),
            prompt_studio_template: None,
        }
        .normalize()
        .unwrap();
        assert_eq!(settings.resolve(App::DescribeImage), "Describe custom");
        assert_eq!(
            settings.resolve(App::Chat),
            "You are a helpful AI assistant."
        );
        assert_eq!(settings.resolve(App::ImageCycles), "Cycles custom");
        assert_eq!(settings.resolve(App::GeneratorImprover), "Improver custom");
        assert_eq!(settings.resolve(App::PromptStudioSystem), "Studio custom");
        let default = PromptDefaults::default();
        assert_eq!(
            default.resolve(App::ImageCycles),
            default.resolve(App::DescribeImage)
        );
        assert_ne!(
            default.resolve(App::GeneratorImprover),
            default.resolve(App::DescribeImage)
        );
        assert!(
            PromptDefaults {
                chat: Some("x".repeat(32_001)),
                ..Default::default()
            }
            .normalize()
            .is_err()
        );
    }
}
