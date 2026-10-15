//! OpenAI / OpenRouter chat-completion wire format ↔ OffloadMQ `llm.*` tasks.
//!
//! Requests become an Ollama-native `/api/chat` payload (`messages`, `options`,
//! `format`, `tools`, `think`) that the agent forwards to Ollama as-is.
//! Task output (Ollama's `{message, done_reason, eval_count, ...}`) becomes an
//! OpenAI `chat.completion` / `chat.completion.chunk`. Everything here is pure.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::error::OrError;

/// `POST /api/v1/chat/completions` body. Only the fields that map onto Ollama
/// are typed; OpenRouter routing knobs (`provider`, `transforms`, `plugins`,
/// `route`, `user`, `usage`, `stream_options`, ...) are accepted and ignored.
#[derive(Debug, Default, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: Option<String>,
    /// OpenRouter fallback list, tried in order after `model`.
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub messages: Vec<Value>,
    /// Bare prompt — OpenRouter accepts it in place of `messages`.
    pub prompt: Option<String>,
    #[serde(default)]
    pub stream: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub min_p: Option<f64>,
    pub seed: Option<i64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub repetition_penalty: Option<f64>,
    pub max_tokens: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub stop: Option<Value>,
    pub response_format: Option<Value>,
    pub tools: Option<Vec<Value>>,
    pub tool_choice: Option<Value>,
    /// OpenRouter: `{effort, max_tokens, exclude, enabled}`.
    pub reasoning: Option<Value>,
    /// OpenAI-style shorthand for `reasoning.effort`.
    pub reasoning_effort: Option<String>,
    /// Legacy OpenRouter flag.
    pub include_reasoning: Option<bool>,
}

impl ChatCompletionRequest {
    /// `model` followed by the `models` fallbacks, de-duplicated.
    pub fn model_candidates(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for m in self.model.iter().chain(self.models.iter()) {
            let m = m.trim();
            if !m.is_empty() && !out.iter().any(|o| o == m) {
                out.push(m.to_string());
            }
        }
        out
    }

    /// True when the client asked for the reasoning text to be left out.
    pub fn exclude_reasoning(&self) -> bool {
        self.reasoning
            .as_ref()
            .and_then(|r| r.get("exclude"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

/// Build the Ollama-native task payload for `model` (the local model name,
/// e.g. `qwen3:8b`). `stream` is always true so agents report the generated
/// text as progress — the client's own `stream` flag only picks SSE vs JSON.
pub fn build_task_payload(req: &ChatCompletionRequest, model: &str) -> Result<Value, OrError> {
    let mut messages = convert_messages(&req.messages)?;
    if messages.is_empty() {
        match req.prompt.as_deref() {
            Some(p) if !p.is_empty() => messages.push(json!({"role": "user", "content": p})),
            _ => {
                return Err(OrError::bad_request(
                    "Either messages or prompt is required",
                ));
            }
        }
    }

    let mut payload = Map::new();
    payload.insert("messages".into(), Value::Array(messages));
    payload.insert("stream".into(), Value::Bool(true));

    let options = build_options(req);
    if !options.is_empty() {
        payload.insert("options".into(), Value::Object(options));
    }
    if let Some(format) = response_format_to_ollama(req.response_format.as_ref())? {
        payload.insert("format".into(), format);
    }
    let tools_disabled = req.tool_choice.as_ref().and_then(Value::as_str) == Some("none");
    if let Some(tools) = req
        .tools
        .as_ref()
        .filter(|t| !t.is_empty() && !tools_disabled)
    {
        payload.insert("tools".into(), Value::Array(tools.clone()));
    }
    if let Some(think) = think_setting(req, model) {
        payload.insert("think".into(), think);
    }
    Ok(Value::Object(payload))
}

fn build_options(req: &ChatCompletionRequest) -> Map<String, Value> {
    let mut o = Map::new();
    let mut put = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            o.insert(k.to_string(), v);
        }
    };
    put("temperature", req.temperature.map(Value::from));
    put("top_p", req.top_p.map(Value::from));
    put("top_k", req.top_k.map(Value::from));
    put("min_p", req.min_p.map(Value::from));
    put("seed", req.seed.map(Value::from));
    put("presence_penalty", req.presence_penalty.map(Value::from));
    put("frequency_penalty", req.frequency_penalty.map(Value::from));
    put("repeat_penalty", req.repetition_penalty.map(Value::from));
    put(
        "num_predict",
        req.max_completion_tokens
            .or(req.max_tokens)
            .map(Value::from),
    );
    put(
        "stop",
        match &req.stop {
            Some(Value::String(s)) => Some(json!([s])),
            Some(Value::Array(a)) if !a.is_empty() => Some(Value::Array(a.clone())),
            _ => None,
        },
    );
    o
}

/// `json_object` → `"json"`, `json_schema` → the schema itself; `text` → none.
fn response_format_to_ollama(rf: Option<&Value>) -> Result<Option<Value>, OrError> {
    let Some(rf) = rf else { return Ok(None) };
    match rf.get("type").and_then(Value::as_str) {
        None | Some("text") => Ok(None),
        Some("json_object") => Ok(Some(json!("json"))),
        Some("json_schema") => rf
            .get("json_schema")
            .and_then(|js| js.get("schema"))
            .cloned()
            .map(Some)
            .ok_or_else(|| OrError::bad_request("response_format.json_schema.schema is required")),
        Some(other) => Err(OrError::bad_request(format!(
            "Unsupported response_format type: {other}"
        ))),
    }
}

/// Map OpenRouter `reasoning` / `reasoning_effort` / `include_reasoning` to
/// Ollama's `think`. Absent → the model's default. gpt-oss takes an effort
/// level; every other thinking model takes a bool.
fn think_setting(req: &ChatCompletionRequest, model: &str) -> Option<Value> {
    let r = req.reasoning.as_ref();
    let effort = r
        .and_then(|r| r.get("effort"))
        .and_then(Value::as_str)
        .or(req.reasoning_effort.as_deref());
    let enabled = r.and_then(|r| r.get("enabled")).and_then(Value::as_bool);

    if enabled == Some(false) || matches!(effort, Some("none" | "minimal")) {
        return Some(Value::Bool(false));
    }
    if let Some(effort) = effort {
        if model.starts_with("gpt-oss") && matches!(effort, "low" | "medium" | "high") {
            return Some(json!(effort));
        }
        return Some(Value::Bool(true));
    }
    if r.is_some() {
        // `{}`, `{enabled: true}`, `{max_tokens: n}`, `{exclude: true}` — reasoning on.
        return Some(Value::Bool(true));
    }
    req.include_reasoning.map(Value::Bool)
}

/// OpenAI messages → Ollama messages:
/// - `developer` role → `system`
/// - content-part arrays → text `content` + base64 `images` (data URLs only)
/// - `null` content → `""`
/// - assistant `tool_calls[].function.arguments` JSON strings → objects
/// - `tool` messages get `tool_name` from the matching earlier tool call
fn convert_messages(messages: &[Value]) -> Result<Vec<Value>, OrError> {
    let mut tool_names: Vec<(String, String)> = Vec::new();
    let mut out = Vec::with_capacity(messages.len());
    for (i, msg) in messages.iter().enumerate() {
        let Some(obj) = msg.as_object() else {
            return Err(OrError::bad_request(format!(
                "messages[{i}] must be an object"
            )));
        };
        let mut m = obj.clone();
        let role = m
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        if role == "developer" {
            m.insert("role".into(), json!("system"));
        }

        match m.remove("content") {
            None | Some(Value::Null) => {
                m.insert("content".into(), json!(""));
            }
            Some(Value::Array(parts)) => {
                let (text, images) = flatten_content_parts(&parts, i)?;
                m.insert("content".into(), Value::String(text));
                if !images.is_empty() {
                    let mut all = m
                        .get("images")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    all.extend(images.into_iter().map(Value::String));
                    m.insert("images".into(), Value::Array(all));
                }
            }
            Some(other) => {
                m.insert("content".into(), other);
            }
        }

        if let Some(Value::Array(calls)) = m.get_mut("tool_calls") {
            for call in calls.iter_mut() {
                if let (Some(id), Some(name)) = (
                    call.get("id").and_then(Value::as_str),
                    call.pointer("/function/name").and_then(Value::as_str),
                ) {
                    tool_names.push((id.to_string(), name.to_string()));
                }
                if let Some(args) = call.pointer_mut("/function/arguments")
                    && let Some(s) = args.as_str()
                    && let Ok(parsed) = serde_json::from_str::<Value>(s)
                {
                    *args = parsed;
                }
            }
        }

        if role == "tool" && !m.contains_key("tool_name") {
            let call_id = m.get("tool_call_id").and_then(Value::as_str);
            if let Some((_, name)) = call_id.and_then(|id| tool_names.iter().find(|(c, _)| c == id))
            {
                m.insert("tool_name".into(), json!(name));
            }
        }
        out.push(Value::Object(m));
    }
    Ok(out)
}

fn flatten_content_parts(parts: &[Value], index: usize) -> Result<(String, Vec<String>), OrError> {
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    texts.push(t.to_string());
                }
            }
            Some("image_url") => {
                let url = part
                    .get("image_url")
                    .and_then(|iu| iu.get("url").or(Some(iu)))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match url
                    .strip_prefix("data:")
                    .and_then(|rest| rest.split_once(','))
                {
                    Some((_, data)) => images.push(data.to_string()),
                    None => {
                        return Err(OrError::bad_request(format!(
                            "messages[{index}]: only base64 data: URLs are supported for images"
                        )));
                    }
                }
            }
            // Audio, files, cache_control-only parts, ...: not supported by
            // Ollama chat — skipped rather than failing the whole request.
            _ => {}
        }
    }
    Ok((texts.join("\n"), images))
}

// ---------------------------------------------------------------------------
// Task output → OpenAI response
// ---------------------------------------------------------------------------

/// What an `llm.*` agent produced, normalised from its task output.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Completion {
    pub content: String,
    pub reasoning: Option<String>,
    /// Already in OpenAI form (`id`, `type`, `function.arguments` as a string).
    pub tool_calls: Vec<Value>,
    pub native_finish_reason: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
}

impl Completion {
    pub fn from_output(output: Option<&Value>) -> Self {
        let Some(v) = output else {
            return Self::default();
        };
        let msg = v.get("message").or_else(|| v.pointer("/choices/0/message"));
        let content = msg
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .or_else(|| v.get("response").and_then(Value::as_str))
            .or_else(|| v.get("content").and_then(Value::as_str))
            .or_else(|| v.get("partial").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string();
        let reasoning = msg
            .and_then(|m| m.get("thinking").or_else(|| m.get("reasoning")))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let tool_calls = msg
            .and_then(|m| m.get("tool_calls"))
            .and_then(Value::as_array)
            .map(|calls| {
                calls
                    .iter()
                    .enumerate()
                    .map(|(i, c)| openai_tool_call(c, i))
                    .collect()
            })
            .unwrap_or_default();
        let native_finish_reason = v
            .get("done_reason")
            .or_else(|| v.pointer("/choices/0/finish_reason"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let prompt_tokens = v
            .get("prompt_eval_count")
            .or_else(|| v.pointer("/usage/prompt_tokens"))
            .and_then(Value::as_u64);
        let completion_tokens = v
            .get("eval_count")
            .or_else(|| v.pointer("/usage/completion_tokens"))
            .and_then(Value::as_u64);
        Self {
            content,
            reasoning,
            tool_calls,
            native_finish_reason,
            prompt_tokens,
            completion_tokens,
        }
    }

    pub fn finish_reason(&self) -> &'static str {
        if !self.tool_calls.is_empty() {
            return "tool_calls";
        }
        match self.native_finish_reason.as_deref() {
            Some("length") => "length",
            _ => "stop",
        }
    }

    /// Token usage — the agent's counts when it reported them, otherwise a
    /// ~4 chars/token estimate. `cost` is always 0: inference is self-hosted.
    pub fn usage(&self, prompt_chars: usize) -> Value {
        let prompt = self
            .prompt_tokens
            .unwrap_or_else(|| estimate_tokens(prompt_chars));
        let completion = self.completion_tokens.unwrap_or_else(|| {
            estimate_tokens(self.content.len() + self.reasoning.as_ref().map_or(0, String::len))
        });
        json!({
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
            "cost": 0,
            "is_byok": false,
            "prompt_tokens_details": { "cached_tokens": 0 },
            "completion_tokens_details": { "reasoning_tokens": 0 },
        })
    }
}

fn estimate_tokens(chars: usize) -> u64 {
    chars.div_ceil(4) as u64
}

/// Total text length of the request messages, for the usage estimate.
pub fn prompt_chars(payload: &Value) -> usize {
    payload
        .get("messages")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter_map(|m| m.get("content").and_then(Value::as_str))
                .map(str::len)
                .sum()
        })
        .unwrap_or(0)
}

/// Ollama tool call (`{function: {name, arguments: {...}}}`) → OpenAI form.
fn openai_tool_call(call: &Value, index: usize) -> Value {
    let name = call.pointer("/function/name").cloned().unwrap_or(json!(""));
    let arguments = match call.pointer("/function/arguments") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => "{}".to_string(),
    };
    let id = call
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("call_{index}"));
    json!({
        "index": index,
        "id": id,
        "type": "function",
        "function": { "name": name, "arguments": arguments },
    })
}

/// Shared `id` / `model` / `created` envelope of every response object.
pub struct ResponseMeta {
    pub id: String,
    pub model: String,
    pub created: i64,
}

impl ResponseMeta {
    fn envelope(&self, object: &str) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("provider".into(), json!("OffloadMQ"));
        m.insert("model".into(), json!(self.model));
        m.insert("object".into(), json!(object));
        m.insert("created".into(), json!(self.created));
        m
    }

    /// Non-streaming `chat.completion`.
    pub fn completion(
        &self,
        c: &Completion,
        prompt_chars: usize,
        exclude_reasoning: bool,
    ) -> Value {
        let mut message = Map::new();
        message.insert("role".into(), json!("assistant"));
        message.insert(
            "content".into(),
            if c.content.is_empty() && !c.tool_calls.is_empty() {
                Value::Null
            } else {
                json!(c.content)
            },
        );
        message.insert("refusal".into(), Value::Null);
        if let Some(r) = c.reasoning.as_ref().filter(|_| !exclude_reasoning) {
            message.insert("reasoning".into(), json!(r));
        }
        if !c.tool_calls.is_empty() {
            message.insert("tool_calls".into(), Value::Array(c.tool_calls.clone()));
        }
        let mut m = self.envelope("chat.completion");
        m.insert(
            "choices".into(),
            json!([{
                "index": 0,
                "logprobs": null,
                "finish_reason": c.finish_reason(),
                "native_finish_reason": c.native_finish_reason.as_deref().unwrap_or("stop"),
                "message": message,
            }]),
        );
        m.insert("usage".into(), c.usage(prompt_chars));
        Value::Object(m)
    }

    /// One `chat.completion.chunk` with the given `delta`.
    pub fn chunk(&self, delta: Value, finish_reason: Option<&str>, native: Option<&str>) -> Value {
        let mut m = self.envelope("chat.completion.chunk");
        m.insert(
            "choices".into(),
            json!([{
                "index": 0,
                "delta": delta,
                "logprobs": null,
                "finish_reason": finish_reason,
                "native_finish_reason": native,
            }]),
        );
        Value::Object(m)
    }

    /// The last chunk: repeats `finish_reason` with an empty delta and carries `usage`.
    pub fn final_chunk(&self, c: &Completion, prompt_chars: usize) -> Value {
        let mut v = self.chunk(
            json!({"role": "assistant", "content": ""}),
            Some(c.finish_reason()),
            Some(c.native_finish_reason.as_deref().unwrap_or("stop")),
        );
        v["usage"] = c.usage(prompt_chars);
        v
    }

    /// Mid-stream failure: a chunk with a top-level `error` and `finish_reason: "error"`.
    pub fn error_chunk(&self, err: &OrError) -> Value {
        let mut v = self.chunk(json!({"content": ""}), Some("error"), Some("error"));
        v["error"] = err.body();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(v: Value) -> ChatCompletionRequest {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn maps_sampling_params_into_ollama_options() {
        let r = req(json!({
            "model": "qwen3:8b",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.2, "top_p": 0.9, "top_k": 40, "seed": 7,
            "repetition_penalty": 1.1, "max_tokens": 64, "stop": "END",
            "provider": {"order": ["x"]}, "transforms": ["middle-out"]
        }));
        let p = build_task_payload(&r, "qwen3:8b").unwrap();
        assert_eq!(p["stream"], json!(true));
        let o = &p["options"];
        assert_eq!(o["temperature"], json!(0.2));
        assert_eq!(o["top_k"], json!(40));
        assert_eq!(o["seed"], json!(7));
        assert_eq!(o["repeat_penalty"], json!(1.1));
        assert_eq!(o["num_predict"], json!(64));
        assert_eq!(o["stop"], json!(["END"]));
        assert!(p.get("provider").is_none());
    }

    #[test]
    fn max_completion_tokens_wins_over_max_tokens() {
        let r = req(json!({"prompt": "x", "max_tokens": 10, "max_completion_tokens": 20}));
        let p = build_task_payload(&r, "m").unwrap();
        assert_eq!(p["options"]["num_predict"], json!(20));
    }

    #[test]
    fn prompt_becomes_user_message_and_empty_request_is_rejected() {
        let p = build_task_payload(&req(json!({"prompt": "hello"})), "m").unwrap();
        assert_eq!(p["messages"], json!([{"role": "user", "content": "hello"}]));
        assert!(p.get("options").is_none());
        let err = build_task_payload(&req(json!({"model": "m"})), "m").unwrap_err();
        assert_eq!(err.status.as_u16(), 400);
    }

    #[test]
    fn response_format_maps_to_ollama_format() {
        let r = req(json!({"prompt": "x", "response_format": {"type": "json_object"}}));
        assert_eq!(
            build_task_payload(&r, "m").unwrap()["format"],
            json!("json")
        );

        let schema = json!({"type": "object", "properties": {"a": {"type": "string"}}});
        let r = req(json!({"prompt": "x", "response_format": {
            "type": "json_schema", "json_schema": {"name": "s", "schema": schema}
        }}));
        assert_eq!(build_task_payload(&r, "m").unwrap()["format"], schema);

        let r = req(json!({"prompt": "x", "response_format": {"type": "text"}}));
        assert!(build_task_payload(&r, "m").unwrap().get("format").is_none());
    }

    #[test]
    fn messages_are_normalised_for_ollama() {
        let r = req(json!({"messages": [
            {"role": "developer", "content": "be brief"},
            {"role": "user", "content": [
                {"type": "text", "text": "what is this?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}
            ]},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "get_weather", "arguments": "{\"city\":\"Kyiv\"}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_1", "content": "sunny"}
        ]}));
        let p = build_task_payload(&r, "m").unwrap();
        let ms = p["messages"].as_array().unwrap();
        assert_eq!(ms[0]["role"], json!("system"));
        assert_eq!(ms[1]["content"], json!("what is this?"));
        assert_eq!(ms[1]["images"], json!(["QUJD"]));
        assert_eq!(ms[2]["content"], json!(""));
        assert_eq!(
            ms[2]["tool_calls"][0]["function"]["arguments"],
            json!({"city": "Kyiv"})
        );
        assert_eq!(ms[3]["tool_name"], json!("get_weather"));
    }

    #[test]
    fn remote_image_urls_are_rejected() {
        let r = req(json!({"messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
        ]}]}));
        assert_eq!(
            build_task_payload(&r, "m").unwrap_err().status.as_u16(),
            400
        );
    }

    #[test]
    fn tools_pass_through_unless_tool_choice_none() {
        let tool = json!({"type": "function", "function": {"name": "f", "parameters": {}}});
        let r = req(json!({"prompt": "x", "tools": [tool.clone()]}));
        assert_eq!(
            build_task_payload(&r, "m").unwrap()["tools"],
            json!([tool.clone()])
        );
        let r = req(json!({"prompt": "x", "tools": [tool], "tool_choice": "none"}));
        assert!(build_task_payload(&r, "m").unwrap().get("tools").is_none());
    }

    #[test]
    fn reasoning_maps_to_think() {
        let think = |v: Value, model: &str| {
            build_task_payload(&req(v), model)
                .unwrap()
                .get("think")
                .cloned()
        };
        assert_eq!(think(json!({"prompt": "x"}), "qwen3"), None);
        assert_eq!(
            think(
                json!({"prompt": "x", "reasoning": {"effort": "high"}}),
                "qwen3"
            ),
            Some(json!(true))
        );
        assert_eq!(
            think(
                json!({"prompt": "x", "reasoning": {"effort": "low"}}),
                "gpt-oss:20b"
            ),
            Some(json!("low"))
        );
        assert_eq!(
            think(
                json!({"prompt": "x", "reasoning": {"enabled": false}}),
                "qwen3"
            ),
            Some(json!(false))
        );
        assert_eq!(
            think(
                json!({"prompt": "x", "reasoning": {"max_tokens": 100}}),
                "qwen3"
            ),
            Some(json!(true))
        );
        assert_eq!(
            think(json!({"prompt": "x", "reasoning_effort": "none"}), "qwen3"),
            Some(json!(false))
        );
        assert_eq!(
            think(json!({"prompt": "x", "include_reasoning": true}), "qwen3"),
            Some(json!(true))
        );
    }

    #[test]
    fn model_candidates_dedupes_fallbacks() {
        let r = req(json!({"model": "a", "models": ["b", "a", " ", "c"]}));
        assert_eq!(r.model_candidates(), vec!["a", "b", "c"]);
    }

    #[test]
    fn completion_from_ollama_output() {
        let out = json!({
            "model": "qwen3:8b",
            "message": {"role": "assistant", "content": "Hello", "thinking": "hmm"},
            "done": true, "done_reason": "length",
            "prompt_eval_count": 12, "eval_count": 5
        });
        let c = Completion::from_output(Some(&out));
        assert_eq!(c.content, "Hello");
        assert_eq!(c.reasoning.as_deref(), Some("hmm"));
        assert_eq!(c.finish_reason(), "length");
        let u = c.usage(1000);
        assert_eq!(u["prompt_tokens"], json!(12));
        assert_eq!(u["completion_tokens"], json!(5));
        assert_eq!(u["total_tokens"], json!(17));
    }

    #[test]
    fn completion_tool_calls_become_openai_shape() {
        let out = json!({"message": {"role": "assistant", "content": "", "tool_calls": [
            {"function": {"name": "get_weather", "arguments": {"city": "Kyiv"}}}
        ]}});
        let c = Completion::from_output(Some(&out));
        assert_eq!(c.finish_reason(), "tool_calls");
        let call = &c.tool_calls[0];
        assert_eq!(call["id"], json!("call_0"));
        assert_eq!(call["type"], json!("function"));
        assert_eq!(call["function"]["arguments"], json!("{\"city\":\"Kyiv\"}"));

        let meta = ResponseMeta {
            id: "gen-1".into(),
            model: "m".into(),
            created: 0,
        };
        let resp = meta.completion(&c, 0, false);
        assert_eq!(resp["choices"][0]["message"]["content"], Value::Null);
        assert_eq!(resp["choices"][0]["finish_reason"], json!("tool_calls"));
    }

    #[test]
    fn usage_is_estimated_without_agent_counts() {
        let out = json!({"message": {"role": "assistant", "content": "12345678"}});
        let c = Completion::from_output(Some(&out));
        let u = c.usage(10);
        assert_eq!(u["prompt_tokens"], json!(3));
        assert_eq!(u["completion_tokens"], json!(2));
        assert_eq!(c.finish_reason(), "stop");
    }

    #[test]
    fn completion_accepts_openai_and_bare_shapes() {
        let openai = json!({"choices": [{"message": {"content": "a"}, "finish_reason": "stop"}]});
        assert_eq!(Completion::from_output(Some(&openai)).content, "a");
        let bare = json!({"response": "b"});
        assert_eq!(Completion::from_output(Some(&bare)).content, "b");
        assert_eq!(Completion::from_output(None), Completion::default());
    }

    #[test]
    fn reasoning_can_be_excluded_from_response() {
        let out = json!({"message": {"content": "x", "thinking": "secret"}});
        let c = Completion::from_output(Some(&out));
        let meta = ResponseMeta {
            id: "gen-1".into(),
            model: "m".into(),
            created: 0,
        };
        assert!(
            meta.completion(&c, 0, true)["choices"][0]["message"]
                .get("reasoning")
                .is_none()
        );
        assert_eq!(
            meta.completion(&c, 0, false)["choices"][0]["message"]["reasoning"],
            json!("secret")
        );
    }

    #[test]
    fn error_chunk_carries_error_and_finish_reason() {
        let meta = ResponseMeta {
            id: "gen-1".into(),
            model: "m".into(),
            created: 0,
        };
        let v = meta.error_chunk(&OrError::new(axum::http::StatusCode::BAD_GATEWAY, "boom"));
        assert_eq!(v["error"]["code"], json!(502));
        assert_eq!(v["error"]["message"], json!("boom"));
        assert_eq!(v["choices"][0]["finish_reason"], json!("error"));
    }
}
