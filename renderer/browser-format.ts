const megabyteFormat = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 1,
});

const percentFormat = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
});

export function formatMegabytes(bytes: number): string {
  return megabyteFormat.format(bytes / (1024 * 1024));
}

export function formatPercent(percent: number): string {
  return percentFormat.format(percent);
}
