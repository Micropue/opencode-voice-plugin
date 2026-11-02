import { spawn, type ChildProcess } from "node:child_process";

export interface TtsOptions {
  voice: string;
  rate: number;
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " 代码块 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\|/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function speakable(markdown: string, limit = 1200): string {
  const text = plainText(markdown);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}……内容较长，已省略`;
}

export class Speaker {
  private child: ChildProcess | undefined;
  private readonly options: TtsOptions;
  onState: ((speaking: boolean) => void) | undefined;

  constructor(options: TtsOptions) {
    this.options = options;
  }

  get speaking(): boolean {
    return Boolean(this.child);
  }

  speak(text: string): void {
    const value = speakable(text);
    if (!value) return;
    this.stop();
    const args = ["-v", this.options.voice, "-r", String(this.options.rate), value];
    let child: ChildProcess;
    try {
      child = spawn("say", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      this.onState?.(false);
      return;
    }
    this.child = child;
    this.onState?.(true);
    child.on("error", () => this.finish());
    child.on("close", () => this.finish());
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.onState?.(false);
  }

  private finish(): void {
    if (!this.child) return;
    this.child = undefined;
    this.onState?.(false);
  }
}
