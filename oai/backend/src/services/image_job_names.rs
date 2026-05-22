//! Human-readable display names for image generation jobs.

use names::Generator;

use crate::db::image_generation::ImageGenerationJob;

pub fn generate_display_name() -> String {
    Generator::default().next().expect("names generator yields a name")
}

/// Stored slug (e.g. `rusty-nail`), or prompt excerpt for legacy rows without a slug.
pub fn effective_display_name(job: &ImageGenerationJob) -> String {
    let stored = job.display_name.trim();
    if !stored.is_empty() {
        return stored.to_string();
    }
    prompt_excerpt(&job.prompt, 48)
}

/// User-facing label in progress UI and similar — always the prompt, not the slug.
pub fn prompt_label(job: &ImageGenerationJob, max_len: usize) -> String {
    prompt_excerpt(&job.prompt, max_len)
}

fn prompt_excerpt(prompt: &str, max_len: usize) -> String {
    let t = prompt.trim();
    if t.is_empty() {
        return "Untitled pipeline".to_string();
    }
    if t.chars().count() <= max_len {
        return t.to_string();
    }
    let end: String = t.chars().take(max_len).collect();
    format!("{}…", end.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_display_name_is_non_empty() {
        let name = generate_display_name();
        assert!(!name.is_empty());
        assert!(name.contains('-'));
    }

    #[test]
    fn prompt_excerpt_truncates() {
        let long = "a".repeat(60);
        let ex = prompt_excerpt(&long, 10);
        assert!(ex.ends_with('…'));
        assert!(ex.chars().count() <= 11);
    }
}
