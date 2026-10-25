import type { TaskErrorCode } from "../shared/task";

export const TASK_ERROR_MESSAGES: Record<TaskErrorCode, string> = {
  task_session_not_found: "Sesi tidak ditemukan.",
  task_session_not_ready: "Sesi belum siap menerima task.",
  task_idempotency_conflict: "Idempotency-Key sudah dipakai untuk permintaan berbeda.",
  task_not_found: "Task tidak ditemukan.",
  task_not_cancellable: "Task tidak dapat dibatalkan pada status ini.",
  task_not_waiting_approval: "Task tidak sedang menunggu persetujuan.",
  task_invalid_transition: "Perubahan status task tidak valid.",
};

export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode) {
    super(TASK_ERROR_MESSAGES[code]);
    this.name = "TaskError";
    this.code = code;
  }
}
