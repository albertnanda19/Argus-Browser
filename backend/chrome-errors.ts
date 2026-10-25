import type { ChromeInstallerErrorCode } from "../shared/chrome-installer";

export const CHROME_ERROR_MESSAGES: Record<ChromeInstallerErrorCode, string> = {
  chrome_download_failed:
    "Unduhan Chrome for Testing gagal. Periksa koneksi internet lalu coba lagi.",
  chrome_checksum_mismatch:
    "Berkas unduhan Chrome for Testing tidak valid. Coba unduh ulang.",
  chrome_extract_failed:
    "Berkas Chrome for Testing gagal diekstrak. Coba unduh ulang.",
  chrome_executable_not_found:
    "Chrome for Testing tidak ditemukan setelah ekstraksi. Coba unduh ulang.",
  chrome_local_invalid:
    "Berkas yang dipilih bukan Chrome for Testing yang dapat dijalankan.",
  chrome_local_missing: "Chrome for Testing lokal tidak ditemukan.",
  chrome_platform_unsupported: "Platform ini belum didukung untuk Chrome for Testing.",
};

export class ChromeFailure extends Error {
  readonly code: ChromeInstallerErrorCode;

  constructor(code: ChromeInstallerErrorCode) {
    super(CHROME_ERROR_MESSAGES[code]);
    this.name = "ChromeFailure";
    this.code = code;
  }
}

export class ChromeAbortError extends Error {
  constructor() {
    super("Chrome installation aborted.");
    this.name = "AbortError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ChromeAbortError();
  }
}
