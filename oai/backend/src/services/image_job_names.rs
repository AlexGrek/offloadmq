//! Human-readable display names for image generation jobs.

use std::collections::HashSet;

use names::Generator;
use serde::Serialize;

use crate::db::image_generation::ImageGenerationJob;

const PROMPT_NAME_PLACEHOLDER: &str = "{?}";

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedName {
    pub slug: String,
    pub phrase: String,
}

pub fn generate_display_name() -> String {
    Generator::default().next().expect("names generator yields a name")
}

pub fn generate_random_names(count: usize) -> Vec<GeneratedName> {
    let count = count.clamp(1, 20);
    let mut used = HashSet::new();
    let mut out = Vec::with_capacity(count);
    while out.len() < count {
        let slug = generate_display_name();
        if used.insert(slug.clone()) {
            out.push(GeneratedName {
                phrase: slug.replace('-', " "),
                slug,
            });
        }
    }
    out
}

/// Replace each `{?}` in a prompt with a random generated name (dashes → spaces).
/// Every placeholder in the same prompt gets a distinct name.
pub fn expand_prompt_placeholders(prompt: &str) -> String {
    if !prompt.contains(PROMPT_NAME_PLACEHOLDER) {
        return prompt.to_string();
    }
    let mut out = String::with_capacity(prompt.len() + 16);
    let mut rest = prompt;
    let mut used = HashSet::new();
    while let Some(idx) = rest.find(PROMPT_NAME_PLACEHOLDER) {
        out.push_str(&rest[..idx]);
        out.push_str(&unique_generated_name_phrase(&mut used));
        rest = &rest[idx + PROMPT_NAME_PLACEHOLDER.len()..];
    }
    out.push_str(rest);
    out
}

fn unique_generated_name_phrase(used: &mut HashSet<String>) -> String {
    loop {
        let phrase = generated_name_phrase();
        if used.insert(phrase.clone()) {
            return phrase;
        }
    }
}

fn generated_name_phrase() -> String {
    generate_display_name().replace('-', " ")
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
    fn generate_random_names_returns_unique_batch() {
        let names = generate_random_names(8);
        assert_eq!(names.len(), 8);
        let slugs: HashSet<_> = names.iter().map(|n| n.slug.as_str()).collect();
        assert_eq!(slugs.len(), 8);
        for name in &names {
            assert!(name.slug.contains('-'));
            assert_eq!(name.phrase, name.slug.replace('-', " "));
        }
    }

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

    #[test]
    fn expand_prompt_placeholders_leaves_plain_text_unchanged() {
        assert_eq!(
            expand_prompt_placeholders("A cinematic fox in neon rain"),
            "A cinematic fox in neon rain",
        );
    }

    #[test]
    fn expand_prompt_placeholders_replaces_marker_with_spaced_name() {
        let expanded = expand_prompt_placeholders("Portrait of {?} at dusk");
        assert!(!expanded.contains("{?}"));
        assert!(expanded.starts_with("Portrait of "));
        assert!(expanded.ends_with(" at dusk"));
        let name = expanded
            .strip_prefix("Portrait of ")
            .and_then(|s| s.strip_suffix(" at dusk"))
            .expect("name segment");
        assert!(!name.is_empty());
        assert!(!name.contains('-'));
        assert!(name.contains(' '));
    }

    #[test]
    fn expand_prompt_placeholders_replaces_each_marker_uniquely() {
        for _ in 0..20 {
            let expanded = expand_prompt_placeholders("{?} meets {?}");
            assert!(!expanded.contains("{?}"));
            let (left, right) = expanded.split_once(" meets ").expect("two names");
            assert!(!left.is_empty());
            assert!(!right.is_empty());
            assert_ne!(left, right);
            assert!(!left.contains('-'));
            assert!(!right.contains('-'));
        }
    }

    #[test]
    fn expand_prompt_placeholders_three_markers_are_all_distinct() {
        for _ in 0..20 {
            let expanded = expand_prompt_placeholders("{?} / {?} / {?}");
            let names: Vec<&str> = expanded.split(" / ").collect();
            assert_eq!(names.len(), 3);
            assert_ne!(names[0], names[1]);
            assert_ne!(names[0], names[2]);
            assert_ne!(names[1], names[2]);
        }
    }
}
