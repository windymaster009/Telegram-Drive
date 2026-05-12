use std::path::Path;
use std::time::{Duration as StdDuration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::{sleep, timeout, Duration};
use uuid::Uuid;

use crate::commands::fs::{
    copy_files_inner, create_folder_inner, delete_file_inner, delete_folder_inner, move_files_inner,
    rename_folder_inner, upload_file_inner, FolderActor,
};
use crate::nas::crypto::now_ts;
use crate::nas::models::{TelegramJobStatus, TelegramJobType, TelegramJobView};
use crate::nas::state::NasState;

const DEFAULT_TELEGRAM_UPLOAD_DELAY_MS: u64 = 3_000;
const DEFAULT_TELEGRAM_CREATE_CHANNEL_DELAY_MS: u64 = 60_000;
const DEFAULT_TELEGRAM_BATCH_UPLOAD_LIMIT: usize = 15;
const DEFAULT_TELEGRAM_BATCH_PAUSE_MS: u64 = 60_000;
const DEFAULT_TELEGRAM_MAX_ATTEMPTS: i32 = 3;
const DEFAULT_TELEGRAM_JOB_TIMEOUT_MS: u64 = 120_000;
const TELEGRAM_FLOOD_WAIT_BUFFER_SECONDS: i64 = 30;
const TELEGRAM_SPAM_LOCKOUT_SECONDS: i64 = 30 * 60;
const TELEGRAM_JOB_STALE_LOCK_SECONDS: i64 = 6 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TelegramWriteJobPayload {
    CreateFolder {
        name: String,
        actor: FolderActor,
    },
    UploadFile {
        path: String,
        folder_id: Option<i64>,
        actor: FolderActor,
    },
    RenameFolder {
        folder_id: i64,
        name: String,
        actor: FolderActor,
    },
    DeleteFolder {
        folder_id: i64,
        actor: FolderActor,
    },
    DeleteFile {
        message_id: i32,
        folder_id: Option<i64>,
        actor: FolderActor,
    },
    MoveFiles {
        message_ids: Vec<i32>,
        source_folder_id: Option<i64>,
        target_folder_id: Option<i64>,
        actor: FolderActor,
    },
    CopyFiles {
        message_ids: Vec<i32>,
        source_folder_id: Option<i64>,
        target_folder_id: Option<i64>,
        actor: FolderActor,
    },
}

pub enum TelegramJobWaitError {
    Failed(String),
    TimedOut(TelegramJobView),
    Missing,
    InvalidResult(String),
}

#[derive(Default)]
struct WorkerExecutionState {
    last_upload_at: Option<Instant>,
    last_create_folder_at: Option<Instant>,
    uploaded_since_pause: usize,
}

pub fn start_telegram_job_worker(state: NasState) {
    let worker_id = format!("telegram-worker-{}", Uuid::new_v4());
    tauri::async_runtime::spawn(async move {
        let mut execution_state = WorkerExecutionState::default();
        log::info!("Telegram job worker started: {}", worker_id);
        loop {
            match worker_iteration(&state, &worker_id, &mut execution_state).await {
                Ok(wait_for) => {
                    let notified = state.telegram_job_notify.notified();
                    tokio::select! {
                        _ = sleep(wait_for) => {}
                        _ = notified => {}
                    }
                }
                Err(err) => {
                    log::error!("Telegram job worker iteration failed: {}", err);
                    let notified = state.telegram_job_notify.notified();
                    tokio::select! {
                        _ = sleep(Duration::from_secs(5)) => {}
                        _ = notified => {}
                    }
                }
            }
        }
    });
}

pub async fn enqueue_telegram_job(
    state: &NasState,
    job_type: TelegramJobType,
    user_id: String,
    payload: &TelegramWriteJobPayload,
    priority: i32,
) -> Result<TelegramJobView, String> {
    let payload_json = serde_json::to_string(payload).map_err(|err| err.to_string())?;
    let job = state
        .db
        .enqueue_telegram_job(
            job_type.clone(),
            user_id,
            payload_json,
            priority,
            telegram_max_attempts(),
            now_ts(),
        )
        .await?;
    log::info!("Telegram job queued: {} {}", job.id, job_type.as_str());
    state.telegram_job_notify.notify_waiters();
    Ok(job)
}

pub async fn wait_for_telegram_job<T: DeserializeOwned>(
    state: &NasState,
    job_id: &str,
    timeout_duration: Duration,
) -> Result<T, TelegramJobWaitError> {
    let start = Instant::now();
    loop {
        let Some(job) = state
            .db
            .get_telegram_job(job_id)
            .await
            .map_err(TelegramJobWaitError::InvalidResult)?
        else {
            return Err(TelegramJobWaitError::Missing);
        };

        match job.status {
            TelegramJobStatus::Completed => {
                let result_json = job
                    .result_json
                    .ok_or_else(|| {
                        TelegramJobWaitError::InvalidResult(
                            "Completed job is missing result payload".to_string(),
                        )
                    })?;
                return serde_json::from_str(&result_json)
                    .map_err(|err| TelegramJobWaitError::InvalidResult(err.to_string()));
            }
            TelegramJobStatus::Failed => {
                return Err(TelegramJobWaitError::Failed(
                    job.error_message
                        .unwrap_or_else(|| "Telegram job failed".to_string()),
                ));
            }
            _ => {
                if start.elapsed() >= timeout_duration {
                    return Err(TelegramJobWaitError::TimedOut(job));
                }
            }
        }

        let remaining = timeout_duration
            .checked_sub(start.elapsed())
            .unwrap_or_else(|| StdDuration::from_millis(1));
        let wait_for = remaining.min(StdDuration::from_secs(1));
        let _ = timeout(wait_for, state.telegram_job_notify.notified()).await;
    }
}

pub fn telegram_job_timeout() -> Duration {
    Duration::from_millis(
        env_u64("TELEGRAM_JOB_TIMEOUT_MS", DEFAULT_TELEGRAM_JOB_TIMEOUT_MS)
            .max(DEFAULT_TELEGRAM_UPLOAD_DELAY_MS),
    )
}

async fn worker_iteration(
    state: &NasState,
    worker_id: &str,
    execution_state: &mut WorkerExecutionState,
) -> Result<Duration, String> {
    if let Some(until) = state.db.get_telegram_global_cooldown().await? {
        let wait_seconds = (until - now_ts()).max(1) as u64;
        log::warn!(
            "Telegram global cooldown is active for another {}s; worker is paused",
            wait_seconds
        );
        return Ok(Duration::from_secs(wait_seconds.min(60)));
    }

    let now = now_ts();
    let Some(job) = state
        .db
        .claim_next_telegram_job(
            worker_id,
            now,
            now - TELEGRAM_JOB_STALE_LOCK_SECONDS,
        )
        .await?
    else {
        return Ok(Duration::from_secs(1));
    };

    log::info!("Telegram job started: {} {}", job.id, job.job_type.as_str());
    let _write_guard = state.telegram_write_gate.lock().await;
    let next_attempt = job.attempts + 1;
    state
        .db
        .mark_telegram_job_running_attempt(&job.id, next_attempt)
        .await?;

    let payload: TelegramWriteJobPayload =
        serde_json::from_str(&job.payload_json).map_err(|err| err.to_string())?;

    apply_operation_delay(&job.job_type, execution_state).await;
    let outcome = execute_job(state, &job.job_type, &payload).await;

    match outcome {
        Ok(result_json) => {
            mark_success_timing(&job.job_type, execution_state);
            state.db.complete_telegram_job(&job.id, result_json).await?;
            maybe_cleanup_job_artifacts(&payload).await;
            log::info!("Telegram job completed: {} {}", job.id, job.job_type.as_str());
        }
        Err(error_message) => {
            if let Some(wait_seconds) = telegram_penalty_seconds(&error_message) {
                let run_after = now_ts() + wait_seconds;
                state
                    .db
                    .set_telegram_global_cooldown(run_after, Some(error_message.clone()))
                    .await?;
                state
                    .db
                    .delay_telegram_job(&job.id, next_attempt, run_after, error_message.clone())
                    .await?;
                log::warn!(
                    "Telegram flood-wait/rate-limit detected for job {}. Delaying queue for {}s",
                    job.id,
                    wait_seconds
                );
            } else if next_attempt >= job.max_attempts {
                state.db.fail_telegram_job(&job.id, error_message.clone()).await?;
                maybe_cleanup_job_artifacts(&payload).await;
                log::error!(
                    "Telegram job failed permanently after {} attempts: {} {}",
                    next_attempt,
                    job.id,
                    error_message
                );
            } else {
                let backoff_seconds = retry_backoff_seconds(next_attempt);
                let run_after = now_ts() + backoff_seconds;
                state
                    .db
                    .delay_telegram_job(&job.id, next_attempt, run_after, error_message.clone())
                    .await?;
                log::warn!(
                    "Telegram job delayed for retry: {} in {}s ({})",
                    job.id,
                    backoff_seconds,
                    error_message
                );
            }
        }
    }

    state.telegram_job_notify.notify_waiters();
    Ok(Duration::from_millis(50))
}

async fn execute_job(
    state: &NasState,
    job_type: &TelegramJobType,
    payload: &TelegramWriteJobPayload,
) -> Result<String, String> {
    match (job_type, payload) {
        (TelegramJobType::CreateFolder, TelegramWriteJobPayload::CreateFolder { name, actor }) => {
            let folder = create_folder_inner(
                name.clone(),
                None,
                Some(actor.clone()),
                state.telegram.as_ref(),
                state,
            )
            .await?;
            serde_json::to_string(&folder).map_err(|err| err.to_string())
        }
        (
            TelegramJobType::UploadFile,
            TelegramWriteJobPayload::UploadFile {
                path,
                folder_id,
                actor,
            },
        ) => {
            let message = upload_file_inner(
                path.clone(),
                *folder_id,
                None,
                None,
                None,
                state.telegram.as_ref(),
                state,
                None,
                Some(actor.clone()),
            )
            .await?;
            serde_json::to_string(&json!({ "message": message })).map_err(|err| err.to_string())
        }
        (
            TelegramJobType::RenameFolder,
            TelegramWriteJobPayload::RenameFolder {
                folder_id,
                name,
                actor,
            },
        ) => {
            let folder = rename_folder_inner(
                *folder_id,
                name.clone(),
                None,
                Some(actor.clone()),
                state.telegram.as_ref(),
                state,
            )
            .await?;
            serde_json::to_string(&folder).map_err(|err| err.to_string())
        }
        (
            TelegramJobType::DeleteFolder,
            TelegramWriteJobPayload::DeleteFolder { folder_id, actor },
        ) => {
            let ok = delete_folder_inner(
                *folder_id,
                None,
                Some(actor.clone()),
                state.telegram.as_ref(),
                state,
            )
            .await?;
            serde_json::to_string(&json!({ "ok": ok })).map_err(|err| err.to_string())
        }
        (
            TelegramJobType::DeleteFile,
            TelegramWriteJobPayload::DeleteFile {
                message_id,
                folder_id,
                actor,
            },
        ) => {
            let ok = delete_file_inner(
                *message_id,
                *folder_id,
                None,
                state.telegram.as_ref(),
                state,
                Some(actor.clone()),
            )
            .await?;
            serde_json::to_string(&json!({ "ok": ok })).map_err(|err| err.to_string())
        }
        (
            TelegramJobType::MoveFiles,
            TelegramWriteJobPayload::MoveFiles {
                message_ids,
                source_folder_id,
                target_folder_id,
                actor,
            },
        ) => {
            let ok = move_files_inner(
                message_ids.clone(),
                *source_folder_id,
                *target_folder_id,
                None,
                state.telegram.as_ref(),
                state,
                Some(actor.clone()),
            )
            .await?;
            serde_json::to_string(&json!({ "ok": ok })).map_err(|err| err.to_string())
        }
        (
            TelegramJobType::CopyFiles,
            TelegramWriteJobPayload::CopyFiles {
                message_ids,
                source_folder_id,
                target_folder_id,
                actor,
            },
        ) => {
            let ok = copy_files_inner(
                message_ids.clone(),
                *source_folder_id,
                *target_folder_id,
                None,
                state.telegram.as_ref(),
                state,
                Some(actor.clone()),
            )
            .await?;
            serde_json::to_string(&json!({ "ok": ok })).map_err(|err| err.to_string())
        }
        _ => Err("Telegram job payload did not match its job type".to_string()),
    }
}

async fn apply_operation_delay(job_type: &TelegramJobType, execution_state: &mut WorkerExecutionState) {
    match job_type {
        TelegramJobType::CreateFolder => {
            if let Some(last_create) = execution_state.last_create_folder_at {
                let delay = StdDuration::from_millis(telegram_create_channel_delay_ms());
                if let Some(wait_for) = delay.checked_sub(last_create.elapsed()) {
                    log::info!(
                        "Telegram job delayed before create-folder to protect the account: {} ms",
                        wait_for.as_millis()
                    );
                    sleep(wait_for).await;
                }
            }
        }
        TelegramJobType::UploadFile => {
            if execution_state.uploaded_since_pause >= telegram_batch_upload_limit() {
                let pause = StdDuration::from_millis(telegram_batch_pause_ms());
                log::info!(
                    "Telegram upload batch pause started after {} files: {} ms",
                    execution_state.uploaded_since_pause,
                    pause.as_millis()
                );
                sleep(pause).await;
                execution_state.uploaded_since_pause = 0;
            }

            if let Some(last_upload) = execution_state.last_upload_at {
                let delay = StdDuration::from_millis(telegram_upload_delay_ms());
                if let Some(wait_for) = delay.checked_sub(last_upload.elapsed()) {
                    log::info!(
                        "Telegram upload spacing delay: {} ms",
                        wait_for.as_millis()
                    );
                    sleep(wait_for).await;
                }
            }
        }
        _ => {}
    }
}

fn mark_success_timing(job_type: &TelegramJobType, execution_state: &mut WorkerExecutionState) {
    match job_type {
        TelegramJobType::CreateFolder => {
            execution_state.last_create_folder_at = Some(Instant::now());
        }
        TelegramJobType::UploadFile => {
            execution_state.last_upload_at = Some(Instant::now());
            execution_state.uploaded_since_pause += 1;
        }
        _ => {}
    }
}

async fn maybe_cleanup_job_artifacts(payload: &TelegramWriteJobPayload) {
    let TelegramWriteJobPayload::UploadFile { path, .. } = payload else {
        return;
    };
    if let Some(parent) = Path::new(path).parent() {
        let _ = tokio::fs::remove_dir_all(parent).await;
    } else {
        let _ = tokio::fs::remove_file(path).await;
    }
}

fn retry_backoff_seconds(attempt: i32) -> i64 {
    let exponent = attempt.saturating_sub(1).clamp(0, 5) as u32;
    (15_i64 * 2_i64.pow(exponent)).min(15 * 60)
}

fn telegram_penalty_seconds(error: &str) -> Option<i64> {
    let upper = error.to_ascii_uppercase();
    if let Some((_, suffix)) = upper.split_once("FLOOD_WAIT_") {
        let digits: String = suffix
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if let Ok(seconds) = digits.parse::<i64>() {
            return Some((seconds + TELEGRAM_FLOOD_WAIT_BUFFER_SECONDS).max(60));
        }
        return Some((60 + TELEGRAM_FLOOD_WAIT_BUFFER_SECONDS).max(60));
    }
    if upper.contains("PEER_FLOOD")
        || upper.contains("PHONE_NUMBER_FLOOD")
        || upper.contains("PHONE_PASSWORD_FLOOD")
        || upper.contains("PHONE_CODE_FLOOD")
        || upper.contains("RATE_LIMIT")
        || upper.contains("TOO_MANY_REQUESTS")
    {
        return Some(TELEGRAM_SPAM_LOCKOUT_SECONDS);
    }
    None
}

fn env_u64(key: &str, default_value: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default_value)
}

fn env_usize(key: &str, default_value: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(default_value)
}

fn env_i32(key: &str, default_value: i32) -> i32 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .unwrap_or(default_value)
}

fn telegram_upload_delay_ms() -> u64 {
    env_u64("TELEGRAM_UPLOAD_DELAY_MS", DEFAULT_TELEGRAM_UPLOAD_DELAY_MS)
}

fn telegram_create_channel_delay_ms() -> u64 {
    env_u64(
        "TELEGRAM_CREATE_CHANNEL_DELAY_MS",
        DEFAULT_TELEGRAM_CREATE_CHANNEL_DELAY_MS,
    )
}

fn telegram_batch_upload_limit() -> usize {
    env_usize(
        "TELEGRAM_BATCH_UPLOAD_LIMIT",
        DEFAULT_TELEGRAM_BATCH_UPLOAD_LIMIT,
    )
}

fn telegram_batch_pause_ms() -> u64 {
    env_u64("TELEGRAM_BATCH_PAUSE_MS", DEFAULT_TELEGRAM_BATCH_PAUSE_MS)
}

fn telegram_max_attempts() -> i32 {
    env_i32("TELEGRAM_MAX_ATTEMPTS", DEFAULT_TELEGRAM_MAX_ATTEMPTS).max(1)
}
