import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

export type VoiceHelperEvent =
  | { type: "hello"; token: string }
  | { type: "ready"; locale: string; onDevice: boolean }
  | { type: "level"; value: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: string; message: string };

export interface VoiceSessionOptions {
  locale: string;
  maxSeconds: number;
  onDevice: boolean;
  allowNetwork: boolean;
  contextual: string[];
  helperPath?: string;
  selftest?: boolean;
}

export function defaultHelperPath(): string {
  try {
    return fileURLToPath(new URL("../../bin/OpenCodeVoice.app", import.meta.url));
  } catch {
    return "";
  }
}

export function helperExists(path: string): boolean {
  return Boolean(path) && existsSync(path);
}

/**
 * macOS TCC only accepts Speech.framework calls from an app bundle with
 * usage-description keys. So the helper is shipped as OpenCodeVoice.app and
 * launched through LaunchServices, which writes JSONL back over a localhost
 * TCP socket. The socket keeps stdio out of the picture entirely.
 */
export class VoiceSession {
  readonly final: Promise<string>;
  lastPartial = "";
  error: { code: string; message: string } | undefined;
  onEvent: ((event: VoiceHelperEvent) => void) | undefined;

  private readonly token = randomBytes(16).toString("hex");
  private server: Server | undefined;
  private socket: Socket | undefined;
  private lines: Interface | undefined;
  private resolveFinal: ((text: string) => void) | undefined;
  private settled = false;
  private hello = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private launchError = "";
  private openProcess: ChildProcess | undefined;

  constructor(options: VoiceSessionOptions) {
    this.final = new Promise<string>((resolve) => {
      this.resolveFinal = resolve;
    });
    void this.launch(options);
  }

  stop(): void {
    if (this.settled) return;
    try {
      this.socket?.write("stop\n");
    } catch {
      // socket may already be closed
    }
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => this.settle(this.lastPartial), 4000);
  }

  cancel(): void {
    if (this.settled) return;
    try {
      this.socket?.write("cancel\n");
    } catch {
      // socket may already be closed
    }
    this.settle(this.lastPartial);
  }

  private async launch(options: VoiceSessionOptions): Promise<void> {
    const appPath = options.helperPath || defaultHelperPath();
    if (!helperExists(appPath)) {
      this.fail("helper_missing", `Voice app not found at ${appPath}. Run scripts/build-voice.sh.`);
      return;
    }

    const server = createServer();
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      this.fail("socket_failed", error instanceof Error ? error.message : String(error));
      return;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      this.fail("socket_failed", "Voice helper did not get a local port.");
      return;
    }

    const args = [
      "-n",
      "-a",
      appPath,
      "--args",
      "--port",
      String(address.port),
      "--token",
      this.token,
      "--locale",
      options.locale,
      "--max-seconds",
      String(options.maxSeconds),
    ];
    if (options.onDevice) args.push("--on-device");
    if (options.allowNetwork) args.push("--allow-network");
    if (options.contextual.length > 0) args.push("--context", options.contextual.join(","));
    if (options.selftest) args.push("--selftest");

    let open: ChildProcess;
    try {
      open = spawn("open", args, { stdio: ["ignore", "ignore", "pipe"] });
      this.openProcess = open;
    } catch (error) {
      this.fail("helper_launch_failed", error instanceof Error ? error.message : String(error));
      return;
    }

    open.stderr?.on("data", (chunk: Buffer | string) => {
      this.launchError += String(chunk);
      if (this.launchError.length > 2000) this.launchError = this.launchError.slice(-2000);
    });
    open.on("error", (error) => {
      this.fail("helper_launch_failed", error.message);
    });
    open.on("close", (code) => {
      if (code && code !== 0 && !this.hello && !this.settled) {
        this.fail("helper_launch_failed", this.launchError.trim() || `open exited with code ${code}`);
      }
    });

    const socket = await new Promise<Socket | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 8000);
      server.once("connection", (connection) => {
        clearTimeout(timer);
        resolve(connection);
      });
    });

    if (!socket) {
      this.fail("helper_launch_failed", this.launchError.trim() || "Voice helper did not connect back.");
      return;
    }
    if (this.settled) {
      socket.destroy();
      return;
    }

    this.socket = socket;
    socket.on("error", (error) => {
      if (!this.settled) this.fail("helper_socket_failed", error.message);
    });
    socket.on("close", () => {
      if (!this.settled) this.settle(this.error ? "" : this.lastPartial);
    });

    this.lines = createInterface({ input: socket });
    this.lines.on("line", (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: VoiceHelperEvent;
    try {
      event = JSON.parse(trimmed) as VoiceHelperEvent;
    } catch {
      return;
    }

    if (!this.hello) {
      if (event.type !== "hello" || event.token !== this.token) {
        this.fail("helper_auth_failed", "Voice helper connected with an invalid token.");
        return;
      }
      this.hello = true;
      return;
    }

    this.onEvent?.(event);

    if (event.type === "partial") {
      this.lastPartial = event.text;
      return;
    }
    if (event.type === "final") {
      this.lastPartial = event.text;
      this.settle(event.text);
      return;
    }
    if (event.type === "error") {
      this.error = { code: event.code, message: event.message };
      this.settle("");
    }
  }

  private fail(code: string, message: string): void {
    if (this.settled) return;
    this.error = { code, message };
    this.onEvent?.({ type: "error", code, message });
    this.settle("");
  }

  private settle(text: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.lines?.close();
    this.socket?.destroy();
    this.server?.close();
    this.resolveFinal?.(text);
  }
}
