//! WebSocket side of Movie Studio: capability listing and the job watcher that
//! drives reconciliation while a client is connected.

use super::*;

/// WS watch loop poll cadence — matches `llm_debate`'s.
pub(super) const WS_POLL_INTERVAL: Duration = Duration::from_secs(1);

pub async fn list_capabilities_ws(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    match list_capabilities(state, user_id).await {
        Ok(caps) => {
            let _ = tx.send(ServerEvent::MovieCapabilities {
                req_id,
                llm: caps.llm,
                video: caps.video,
            });
        }
        Err(e) => send_ws_error(tx, Some(&req_id), &e.to_string()),
    }
}

pub async fn watch_job_ws(
    req_id: String,
    job_id_str: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    let job_id = match job_id_str.parse::<i64>() {
        Ok(id) => id,
        Err(_) => {
            send_ws_error(tx, Some(&req_id), "invalid job_id");
            return;
        }
    };

    let mut events = state.watch.subscribe();
    loop {
        let mut job = match movie::get_job(&state.db, job_id, user_id).await {
            Ok(Some(j)) => j,
            Ok(None) => {
                send_ws_error(tx, Some(&req_id), "job not found");
                return;
            }
            Err(e) => {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        };

        if !task_status::is_terminal(&job.status) {
            if let Err(e) = reconcile_job(state, &mut job).await {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        }

        let terminal = task_status::is_terminal(&job.status);
        match job_view(job) {
            Ok(view) => {
                let _ = tx.send(ServerEvent::MovieUpdate {
                    req_id: req_id.clone(),
                    job: view,
                    terminal,
                });
            }
            Err(e) => {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        }

        if terminal {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(WS_POLL_INTERVAL) => {}
            _ = events.recv() => {}
        }
    }
}

pub(super) fn send_ws_error(tx: &UnboundedSender<ServerEvent>, req_id: Option<&str>, message: &str) {
    let _ = tx.send(ServerEvent::Error {
        req_id: req_id.map(str::to_string),
        message: message.to_string(),
    });
}
