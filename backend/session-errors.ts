import type { SessionErrorCode } from "../shared/session";

export const SESSION_ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  session_profile_not_found: "Profil tidak ditemukan.",
  session_profile_corrupt: "Profil rusak dan tidak dapat dibuka.",
  session_chrome_not_ready: "Chrome for Testing belum siap.",
  session_conflict: "Profil ini sudah memiliki sesi aktif.",
  session_not_found: "Sesi tidak ditemukan.",
  session_launch_failed: "Browser gagal dibuka. Coba lagi.",
  session_close_failed: "Browser gagal ditutup.",
};

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode) {
    super(SESSION_ERROR_MESSAGES[code]);
    this.name = "SessionError";
    this.code = code;
  }
}
