export function formatBytes(bytes: number, locale: string): string {
    if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"] as const;
    let value = bytes / 1024;
    let unit: (typeof units)[number] = units[0];
    for (let index = 1; index < units.length && value >= 1024; index += 1) {
        value /= 1024;
        unit = units[index] ?? unit;
    }
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 1 : 2 }).format(value)} ${unit}`;
}
