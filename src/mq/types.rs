use crate::models::AssignedTask;
use crate::schema::{TaskId, TaskStatus};

/// Domain-level outcome of an urgent (blocking) task submission.
/// No framework types — usable from any transport adapter.
pub enum UrgentSubmitOutcome {
    /// Task was picked up, executed, and the full assigned task record is available.
    Completed(AssignedTask),
    /// Task reached a terminal status but the full assignment record was unavailable.
    CompletedPartial {
        id: TaskId,
        status: TaskStatus,
        message: String,
    },
}
