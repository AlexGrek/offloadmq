//! Random Wikipedia article source for the txt2img "wiki" drawer.
//!
//! Wraps the public REST endpoint `/api/rest_v1/page/random/summary` (no key needed;
//! it answers with a 303 to the concrete summary, which reqwest follows). Wikimedia
//! asks automated clients for a descriptive `User-Agent`, so we always send one.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const USER_AGENT: &str = "oai-wiki-random/1.0 (https://oai.alexgr.space)";
/// Intros shorter than this are stubs ("X is a village in Y") — worth a re-roll.
const MIN_EXTRACT_CHARS: usize = 200;
const MAX_ATTEMPTS: usize = 4;

#[derive(Debug, Clone, Serialize)]
pub struct WikiArticle {
    pub title: String,
    pub description: Option<String>,
    pub extract: String,
    pub thumbnail: Option<String>,
    pub url: String,
    pub lang: String,
}

#[derive(Deserialize)]
struct Summary {
    title: String,
    description: Option<String>,
    extract: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    thumbnail: Option<Thumb>,
    content_urls: Option<ContentUrls>,
}

#[derive(Deserialize)]
struct Thumb {
    source: String,
}

#[derive(Deserialize)]
struct ContentUrls {
    desktop: Option<Page>,
}

#[derive(Deserialize)]
struct Page {
    page: String,
}

/// Wikipedia language editions are 2–3 letters, optionally with a dash segment
/// (`zh-yue`, `simple` is the one longer outlier). Validated because it becomes a
/// hostname label — never let user input pick an arbitrary host.
pub fn normalize_lang(raw: Option<&str>) -> Result<String, AppError> {
    let lang = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("en")
        .to_ascii_lowercase();
    let ok = lang == "simple"
        || (lang.len() <= 8
            && lang
                .split('-')
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase()))
            && lang
                .split('-')
                .next()
                .is_some_and(|p| (2..=3).contains(&p.len())));
    if ok {
        Ok(lang)
    } else {
        Err(AppError::BadRequest(
            "Invalid Wikipedia language code".into(),
        ))
    }
}

/// Fetch a random article, re-rolling a few times to skip stubs and non-articles.
/// If every attempt is a stub, returns the last usable one rather than failing.
pub async fn random_article(http: &reqwest::Client, lang: &str) -> Result<WikiArticle, AppError> {
    let url = format!("https://{lang}.wikipedia.org/api/rest_v1/page/random/summary");
    let mut fallback: Option<WikiArticle> = None;
    for _ in 0..MAX_ATTEMPTS {
        let res = http
            .get(&url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .map_err(|e| AppError::ExternalService(format!("Wikipedia request failed: {e}")))?;
        if !res.status().is_success() {
            return Err(AppError::ExternalService(format!(
                "Wikipedia returned HTTP {}",
                res.status()
            )));
        }
        let summary: Summary = res.json().await.map_err(|e| {
            AppError::ExternalService(format!("Wikipedia sent an unreadable response: {e}"))
        })?;
        if summary.kind.as_deref().is_some_and(|k| k != "standard") {
            continue;
        }
        let extract = summary.extract.unwrap_or_default().trim().to_string();
        if extract.is_empty() {
            continue;
        }
        let article = WikiArticle {
            url: summary
                .content_urls
                .and_then(|c| c.desktop)
                .map(|p| p.page)
                .unwrap_or_else(|| {
                    format!(
                        "https://{lang}.wikipedia.org/wiki/{}",
                        summary.title.replace(' ', "_")
                    )
                }),
            title: summary.title,
            description: summary.description.filter(|d| !d.trim().is_empty()),
            thumbnail: summary.thumbnail.map(|t| t.source),
            lang: lang.to_string(),
            extract,
        };
        if article.extract.chars().count() >= MIN_EXTRACT_CHARS {
            return Ok(article);
        }
        fallback = Some(article);
    }
    fallback.ok_or_else(|| AppError::ExternalService("Wikipedia returned no usable article".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_defaults_and_validates() {
        assert_eq!(normalize_lang(None).unwrap(), "en");
        assert_eq!(normalize_lang(Some("  UK ")).unwrap(), "uk");
        assert_eq!(normalize_lang(Some("simple")).unwrap(), "simple");
        assert_eq!(normalize_lang(Some("zh-yue")).unwrap(), "zh-yue");
        for bad in [
            "evil.com/x",
            "e",
            "en.",
            "a-b",
            "toolonglang",
            "en/../x",
            "-en",
        ] {
            assert!(
                normalize_lang(Some(bad)).is_err(),
                "{bad} should be rejected"
            );
        }
    }
}
