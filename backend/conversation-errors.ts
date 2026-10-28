import type { ConversationErrorCode } from "../shared/conversation";

export const CONVERSATION_ERROR_MESSAGES: Record<ConversationErrorCode, string> = {
  conversation_not_found: "Percakapan tidak ditemukan.",
  conversation_profile_not_found: "Profil tidak ditemukan.",
  conversation_session_not_ready: "Sesi browser belum siap menerima pesan.",
  conversation_idempotency_conflict:
    "Idempotency-Key sudah dipakai untuk permintaan berbeda.",
  conversation_full:
    "Percakapan sudah mencapai batas 2.000 pesan. Buat percakapan baru.",
  conversation_save_failed: "Pesan gagal disimpan.",
};

export class ConversationError extends Error {
  readonly code: ConversationErrorCode;

  constructor(code: ConversationErrorCode) {
    super(CONVERSATION_ERROR_MESSAGES[code]);
    this.name = "ConversationError";
    this.code = code;
  }
}
