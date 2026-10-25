import type { ActionErrorCode } from "../shared/action";

export const ACTION_ERROR_MESSAGES: Record<ActionErrorCode, string> = {
  action_session_not_found: "Sesi tidak ditemukan.",
  action_session_not_ready: "Sesi belum siap menerima aksi.",
  action_task_not_found: "Task tidak ditemukan.",
  action_task_not_running: "Task tidak dapat menerima aksi pada status ini.",
  action_navigation_failed: "Halaman gagal dibuka.",
  action_target_not_found: "Elemen tidak ditemukan atau aksi melewati batas waktu.",
  action_failed: "Aksi gagal dijalankan.",
};

export class ActionError extends Error {
  readonly code: ActionErrorCode;

  constructor(code: ActionErrorCode) {
    super(ACTION_ERROR_MESSAGES[code]);
    this.name = "ActionError";
    this.code = code;
  }
}
