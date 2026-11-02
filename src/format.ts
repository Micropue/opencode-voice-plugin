const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function waveform(levels: readonly number[], width: number): string {
  const size = Math.max(1, Math.floor(width));
  const tail = levels.slice(-size);
  const empty = Math.max(0, size - tail.length);
  const chars = Array.from({ length: empty }, () => " ");
  for (const level of tail) {
    const index = Math.max(0, Math.min(BLOCKS.length - 1, Math.round(level * (BLOCKS.length - 1))));
    chars.push(BLOCKS[index] ?? " ");
  }
  return chars.join("");
}

export function progressBar(percent: number, width: number): string {
  const size = Math.max(1, Math.floor(width));
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = value > 0 ? Math.max(1, Math.round((value / 100) * size)) : 0;
  return "█".repeat(filled) + "─".repeat(size - filled);
}

export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function clock(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function resetAt(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(text: string, width: number): string {
  const size = Math.max(1, Math.floor(width));
  if (text.length <= size) return text;
  if (size <= 1) return "…";
  return `${text.slice(0, size - 1)}…`;
}

export function oneLine(text: string, width: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), width);
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function money(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

