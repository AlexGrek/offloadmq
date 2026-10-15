//! SSE streaming for `stream: true` chat completions.
//!
//! Agents report generated text as progress-log deltas (flushed about every
//! 2 s). A producer task wakes on the task's `progress` lifecycle events, its
//! status changes, and a 15 s keep-alive tick; on each wake it sends the log
//! bytes it hasn't sent yet as a `chat.completion.chunk`. When the task is
//! terminal it sends any remaining content, tool calls / reasoning, a final
//! chunk with `usage`, and `data: [DONE]` — OpenRouter's stream shape.
//!
//! The producer owns the [`UrgentHandle`]: once the client disconnects a send
//! fails, the producer returns, and dropping the handle cancels the task.

use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::response::{
    IntoResponse, Response,
    sse::{Event, Sse},
};
use serde_json::{Value, json};
use tokio::sync::{broadcast::error::RecvError, mpsc};

use super::{
    completion_from_outcome,
    translate::{Completion, ResponseMeta},
};
use crate::{
    mq::scheduler::UrgentHandle,
    state::{AppState, StreamEvent},
};

const KEEPALIVE: Duration = Duration::from_secs(15);

pub fn sse_response(
    state: Arc<AppState>,
    handle: UrgentHandle,
    meta: ResponseMeta,
    prompt_chars: usize,
    exclude_reasoning: bool,
) -> Response {
    let (tx, rx) = mpsc::channel::<Event>(64);
    tokio::spawn(produce(
        state,
        handle,
        meta,
        prompt_chars,
        exclude_reasoning,
        tx,
    ));
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|ev| (Ok::<_, Infallible>(ev), rx))
    });
    let mut resp = Sse::new(stream).into_response();
    // Keep reverse proxies from buffering the stream.
    resp.headers_mut().insert(
        "X-Accel-Buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    resp
}

struct Producer {
    state: Arc<AppState>,
    meta: ResponseMeta,
    tx: mpsc::Sender<Event>,
    /// Text already sent as `delta.content`.
    streamed: String,
    role_sent: bool,
}

/// The client is gone — stop producing (dropping the handle cancels the task).
struct Disconnected;

impl Producer {
    async fn send(&self, event: Event) -> Result<(), Disconnected> {
        self.tx.send(event).await.map_err(|_| Disconnected)
    }

    async fn send_json(&self, v: &Value) -> Result<(), Disconnected> {
        self.send(Event::default().data(v.to_string())).await
    }

    async fn send_content(&mut self, text: &str) -> Result<(), Disconnected> {
        if text.is_empty() {
            return Ok(());
        }
        let mut delta = json!({ "content": text });
        if !self.role_sent {
            delta["role"] = json!("assistant");
            self.role_sent = true;
        }
        let chunk = self.meta.chunk(delta, None, None);
        self.send_json(&chunk).await?;
        self.streamed.push_str(text);
        Ok(())
    }

    /// Send whatever the task log gained since the last flush.
    async fn flush_log(&mut self, handle: &UrgentHandle) -> Result<(), Disconnected> {
        let tail = self
            .state
            .urgent
            .log_since(handle.task_id(), self.streamed.len())
            .await;
        match tail {
            Some(text) => self.send_content(&text).await,
            None => Ok(()),
        }
    }
}

async fn produce(
    state: Arc<AppState>,
    mut handle: UrgentHandle,
    meta: ResponseMeta,
    prompt_chars: usize,
    exclude_reasoning: bool,
    tx: mpsc::Sender<Event>,
) {
    let mut events = state.channels.stream_tx.subscribe();
    let mut events_open = true;
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    let mut p = Producer {
        state,
        meta,
        tx,
        streamed: String::new(),
        role_sent: false,
    };

    // Wait for a terminal status, streaming the log as it grows.
    let status = loop {
        let wake = tokio::select! {
            status = handle.changed() => {
                if status.is_terminal() {
                    break status;
                }
                true
            }
            ev = events.recv(), if events_open => match ev {
                Ok(StreamEvent::TaskLifecycle(e)) => {
                    e.action == "progress" && &e.task_id == handle.task_id()
                }
                Ok(_) => false,
                Err(RecvError::Lagged(_)) => true,
                Err(RecvError::Closed) => {
                    events_open = false;
                    false
                }
            },
            _ = keepalive.tick() => {
                // Also how a silent stream notices the client went away.
                if p.send(Event::default().comment("OPENROUTER PROCESSING")).await.is_err() {
                    return;
                }
                true
            }
        };
        if wake && p.flush_log(&handle).await.is_err() {
            return;
        }
    };

    // Text the agent logged right before resolving.
    if p.flush_log(&handle).await.is_err() {
        return;
    }
    let outcome = handle.finish(status).await;
    let _ = finish_stream(&mut p, outcome, prompt_chars, exclude_reasoning).await;
}

async fn finish_stream(
    p: &mut Producer,
    outcome: crate::mq::types::UrgentSubmitOutcome,
    prompt_chars: usize,
    exclude_reasoning: bool,
) -> Result<(), Disconnected> {
    let mut c: Completion = match completion_from_outcome(outcome) {
        Ok(c) => c,
        Err(err) => {
            p.send_json(&p.meta.error_chunk(&err)).await?;
            return p.send(Event::default().data("[DONE]")).await;
        }
    };

    // The final output is authoritative: send any content the log missed.
    if let Some(rest) = c.content.strip_prefix(p.streamed.as_str()) {
        let rest = rest.to_string();
        p.send_content(&rest).await?;
    } else if c.content.is_empty() {
        c.content = p.streamed.clone();
    }

    let mut extra = serde_json::Map::new();
    if let Some(r) = c.reasoning.as_ref().filter(|_| !exclude_reasoning) {
        extra.insert("reasoning".into(), json!(r));
    }
    if !c.tool_calls.is_empty() {
        extra.insert("tool_calls".into(), Value::Array(c.tool_calls.clone()));
    }
    if !extra.is_empty() {
        if !p.role_sent {
            extra.insert("role".into(), json!("assistant"));
            p.role_sent = true;
        }
        p.send_json(&p.meta.chunk(Value::Object(extra), None, None))
            .await?;
    }

    p.send_json(&p.meta.final_chunk(&c, prompt_chars)).await?;
    p.send(Event::default().data("[DONE]")).await
}
