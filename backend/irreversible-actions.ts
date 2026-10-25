export type IrreversibleActionInput = {
  readonly description: string;
  readonly selector: string;
  readonly instruction: string;
};

const IRREVERSIBLE_PATTERNS: readonly RegExp[] = [
  /\b(?:send|sends|sending|sent|kirim|mengirim|mengirimkan|terkirim|dikirim|reply|replies|replying|balas|membalas|balasan)\b/,
  /\b(?:submit|submits|submitting|kirim formulir|kirim form|simpan formulir)\b/,
  /\b(?:delete|deletes|deleting|remove|removes|removing|hapus|menghapus|dihapus)\b/,
  /\b(?:pay|pays|paying|payment|purchase|purchases|buy|buys|buying|checkout|bayar|membayar|pembayaran|beli|membeli|pembelian)\b/,
  /\b(?:upload|uploads|uploading|unggah|mengunggah|unggahan)\b/,
  /\b(?:publish|publishes|publishing|post|posts|posting|postingan|mempublikasikan|publikasikan|menerbitkan)\b/,
  /\b(?:account settings|pengaturan akun|change password|ganti kata sandi|ubah kata sandi|change settings|update settings|save settings|simpan pengaturan|ubah pengaturan|perbarui pengaturan|mengubah pengaturan)\b/,
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isIrreversibleAction(input: IrreversibleActionInput): boolean {
  const text = normalize(
    `${input.description} ${input.selector} ${input.instruction}`,
  );
  return IRREVERSIBLE_PATTERNS.some((pattern) => pattern.test(text));
}
