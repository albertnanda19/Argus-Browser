export const texts = {
  app: {
    title: "Argus",
    subtitle: "Browser yang dikendalikan AI",
  },
  connection: {
    connecting: "Menghubungkan…",
    connected: "Terhubung",
    failed: "Gagal terhubung",
  },
  restart: "Mulai ulang layanan",
  browser: {
    heading: "Persiapan browser",
    absent: "Chrome for Testing belum terpasang.",
    download: "Unduh Chrome",
    retry: "Coba lagi",
    downloading: "Mengunduh Chrome for Testing…",
    verifying: "Memeriksa checksum unduhan…",
    extracting: "Mengekstrak Chrome for Testing…",
    progressLabel: "Progres unduhan Chrome for Testing",
    percent: (value: string) => `${value}%`,
    receivedOfTotal: (received: string, total: string) => `${received} MB dari ${total} MB`,
    localLabel: "Lokasi file Chrome for Testing",
    localPlaceholder: "Tempel lokasi file di sini",
    useLocal: "Gunakan binary lokal",
    backToManaged: "Kembali ke Chrome terkelola",
    checkFailed: "Gagal memeriksa Chrome.",
    readyManaged: (version: string | null) =>
      version === null ? "Chrome siap" : `Chrome siap (versi ${version})`,
    readyLocal: (version: string | null) =>
      version === null
        ? "Chrome siap (binary lokal)"
        : `Chrome siap (binary lokal, versi ${version})`,
  },
  actions: {
    startingDownload: "Memulai unduhan…",
    checkingLocal: "Memeriksa binary…",
    clearingLocal: "Mengembalikan ke Chrome terkelola…",
  },
  api: {
    unreachable: "Layanan Argus tidak dapat dihubungi.",
    generic: "Terjadi kesalahan. Coba lagi.",
    invalidResponse: "Respons layanan tidak valid.",
  },
} as const;
