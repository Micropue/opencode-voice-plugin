import { spawn } from "node:child_process";
import type { Context } from "@opencode/plugin/tui/context";

export type Delivery = "paste" | "dialog" | "none";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

export async function ensureSession(context: Context): Promise<string | undefined> {
  const route = context.ui.router.current();
  if (route.type === "session") return route.sessionID;

  try {
    const info = await context.client.session.create({
      location: context.location ?? null,
    });
    context.ui.router.navigate({ type: "session", sessionID: info.id });
    await sleep(180);
    return info.id;
  } catch (error) {
    context.ui.toast.show({
      title: "语音",
      message: `无法创建会话：${error instanceof Error ? error.message : String(error)}`,
      variant: "error",
    });
    return undefined;
  }
}

/**
 * The TUI plugin API has no public "set prompt text". The reliable path is the
 * built-in prompt.paste command reading the system clipboard. If that command
 * is unavailable, fall back to an editable dialog that sends directly.
 */
export async function deliverText(context: Context, text: string): Promise<Delivery> {
  const trimmed = text.trim();
  if (!trimmed) return "none";

  const sessionID = await ensureSession(context);
  if (!sessionID) return "none";

  const canPaste = context.keymap.commands().some((command) => command.id === "prompt.paste");
  if (canPaste) {
    const copied = await copyToClipboard(trimmed);
    if (copied) {
      try {
        context.keymap.dispatch("prompt.paste");
      } catch {
        // fall through to the dialog
      }
      await sleep(80);
      context.ui.toast.show({
        title: "语音",
        message: "已填入输入框，Enter 发送；如果没有出现请按 Ctrl+V",
        variant: "success",
      });
      return "paste";
    }
  }

  const edited = await context.ui.dialog.prompt({
    title: "语音输入",
    description: "确认或修改后发送",
    value: trimmed,
  });
  const finalText = edited?.trim();
  if (!finalText) return "none";
  await context.client.session.prompt({ sessionID, text: finalText });
  return "dialog";
}
