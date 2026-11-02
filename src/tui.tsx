import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import type { SessionMessageInfo } from "@opencode/client";
import type { KeyEvent } from "@opentui/core";
import { Show, createSignal } from "solid-js";
import { Dashboard } from "./panel/dashboard.js";
import { deliverText, ensureSession } from "./voice/paste.js";
import { VoiceSession, defaultHelperPath, helperExists, type VoiceHelperEvent } from "./voice/helper.js";
import { Speaker } from "./voice/tts.js";
import { duration, oneLine, progressBar, waveform } from "./format.js";
import type { Controller, HistoryItem, PanelTab, VoiceState } from "./types.js";

const PANEL = "voice.panel";

const DEFAULT_CONTEXT = [
  "OpenCode",
  "opencode",
  "git",
  "diff",
  "commit",
  "branch",
  "pull request",
  "TypeScript",
  "JavaScript",
  "React",
  "API",
  "JSON",
  "token",
  "build",
  "test",
  "deploy",
];

interface Settings {
  keybind: string;
  toggleKeybind: string;
  panelKeybind: string;
  locale: string;
  maxSeconds: number;
  onDevice: boolean;
  allowNetwork: boolean;
  voice: string;
  rate: number;
  autoSpeak: boolean;
  helperPath: string;
  contextual: string[];
  debug: boolean;
}

function readSettings(raw: Readonly<Record<string, any>>): Settings {
  return {
    keybind: typeof raw.keybind === "string" ? raw.keybind : "alt+v",
    toggleKeybind: typeof raw.toggleKeybind === "string" ? raw.toggleKeybind : "ctrl+shift+v",
    panelKeybind: typeof raw.panelKeybind === "string" ? raw.panelKeybind : "ctrl+shift+g",
    locale: typeof raw.locale === "string" ? raw.locale : "zh-CN",
    maxSeconds: Number(raw.maxSeconds) > 0 ? Number(raw.maxSeconds) : 60,
    onDevice: raw.onDevice !== false,
    allowNetwork: raw.allowNetwork === true,
    voice: typeof raw.voice === "string" ? raw.voice : "Tingting",
    rate: Number(raw.rate) > 0 ? Number(raw.rate) : 190,
    autoSpeak: raw.autoSpeak === true,
    helperPath: typeof raw.helperPath === "string" ? raw.helperPath : "",
    contextual: Array.isArray(raw.contextual)
      ? raw.contextual.filter((value: unknown): value is string => typeof value === "string")
      : DEFAULT_CONTEXT,
    debug: raw.debug === true || process.env.OPENCODE_VOICE_DEBUG === "1",
  };
}

function matches(event: KeyEvent, binding: string): boolean {
  const parts = binding
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return false;

  const alt = parts.includes("alt") || parts.includes("option");
  const ctrl = parts.includes("ctrl") || parts.includes("control");
  const shift = parts.includes("shift");
  const cmd = parts.includes("cmd") || parts.includes("super") || parts.includes("meta");

  const hasAlt = (event.option || event.meta) && !event.super;
  if (event.ctrl !== ctrl) return false;
  if (event.shift !== shift) return false;
  if (hasAlt !== alt) return false;
  if (Boolean(event.super) !== cmd) return false;

  const name = event.name.toLowerCase();
  return name === key || (key === "return" && name === "enter");
}

function displayKey(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      const value = part.trim().toLowerCase();
      if (value === "control") return "ctrl";
      if (value === "option") return "alt";
      if (value === "super" || value === "meta") return "cmd";
      return value;
    })
    .join("+");
}

function lastAssistantText(messages: readonly SessionMessageInfo[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    if (text.trim()) return text;
  }
  return undefined;
}

export default Plugin.define({
  id: "voice.assistant",
  async setup(context) {
    const settings = readSettings(context.options);
    const [state, setState] = createSignal<VoiceState>("idle");
    const [levels, setLevels] = createSignal<number[]>([]);
    const [elapsed, setElapsed] = createSignal(0);
    const [partial, setPartial] = createSignal("");
    const [lastText, setLastText] = createSignal("");
    const [goUsage, setGoUsage] = createSignal<{ percent: number; limited: boolean } | null>(null);
    const [panelTab, setPanelTab] = createSignal<PanelTab>("voice");
    const [debugStage, setDebugStage] = createSignal("init");
    const [history, updateHistory] = context.storage.store<{ items: HistoryItem[] }>("history", {
      initial: { items: [] },
    });

    const speaker = new Speaker({ voice: settings.voice, rate: settings.rate });
    speaker.onState = (speaking) => {
      if (speaking) {
        setState("speaking");
      } else if (state() === "speaking") {
        setState("idle");
      }
    };

    let active: VoiceSession | undefined;
    let generation = 0;
    let starting = false;
    let elapsedTimer: ReturnType<typeof setInterval> | undefined;
    let elapsedStartedAt = 0;
    const cleanups: Array<() => void> = [];

    const notify = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
      context.ui.toast.show({ title: "语音", message, variant });
    };

    const notifyError = (code: string, message: string) => {
      if (code === "speech_denied") {
        notify("语音识别权限被拒绝：系统设置 → 隐私与安全性 → 语音识别，允许当前终端。", "error");
        return;
      }
      if (code === "mic_denied") {
        notify("麦克风权限被拒绝：系统设置 → 隐私与安全性 → 麦克风，允许当前终端。", "error");
        return;
      }
      if (code === "helper_missing") {
        notify("语音 App 不存在，请先运行 npm run build:voice。", "error");
        return;
      }
      if (code === "helper_launch_failed" || code === "helper_socket_failed" || code === "helper_auth_failed") {
        notify(message || "语音 App 启动失败。", "error");
        return;
      }
      if (code === "helper_exit") {
        notify(message || "语音 App 异常退出。", "error");
        return;
      }
      if (code === "on_device_unavailable") {
        notify("当前语言没有可用的离线识别模型；可在插件 options 中设置 allowNetwork: true。", "warning");
        return;
      }
      notify(message || code, "error");
    };

    function clearElapsed() {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
    }

    function startElapsed() {
      clearElapsed();
      elapsedStartedAt = Date.now();
      setElapsed(0);
      elapsedTimer = setInterval(() => {
        const value = (Date.now() - elapsedStartedAt) / 1000;
        setElapsed(value);
        if (value >= settings.maxSeconds) stopListening();
      }, 100);
    }

    function buildContextual(): string[] {
      const values = [...settings.contextual];
      const directory = context.location?.directory;
      if (directory) {
        const name = directory.split("/").filter(Boolean).at(-1);
        if (name) values.push(name);
      }
      const info = context.location ? context.data.location.vcs.info(context.location) : undefined;
      if (info?.branch.current) values.push(info.branch.current);
      return [...new Set(values)];
    }

    function handleEvent(event: VoiceHelperEvent) {
      if (event.type === "level") {
        const value = Math.max(0, Math.min(1, event.value));
        setLevels((previous) => {
          const next = [...previous, value];
          return next.length > 80 ? next.slice(-80) : next;
        });
        return;
      }
      if (event.type === "partial") {
        setPartial(event.text);
        return;
      }
      if (event.type === "error") {
        notifyError(event.code, event.message);
      }
    }

    async function startListening() {
      if (starting) return;
      if (state() === "listening" || state() === "transcribing" || state() === "pasting") return;

      const helperPath = settings.helperPath || defaultHelperPath();
      if (!helperExists(helperPath)) {
        notify("语音 App 不存在，请先运行 npm run build:voice。", "error");
        return;
      }

      starting = true;
      const requestGeneration = ++generation;
      speaker.stop();
      active?.cancel();
      setPartial("");
      setLevels([]);
      setElapsed(0);

      const session = new VoiceSession({
        locale: settings.locale,
        maxSeconds: settings.maxSeconds,
        onDevice: settings.onDevice,
        allowNetwork: settings.allowNetwork,
        contextual: buildContextual(),
        helperPath,
        selftest: process.env.OPENCODE_VOICE_DEBUG_HELPER === "selftest",
      });
      active = session;
      session.onEvent = handleEvent;
      setState("listening");
      startElapsed();

      try {
        const text = await session.final;
        if (requestGeneration !== generation) return;
        clearElapsed();

        if (session.error) {
          setState("idle");
          return;
        }

        const value = text.trim();
        if (!value) {
          notify("没有识别到语音，请靠近麦克风再试一次。", "warning");
          setState("idle");
          return;
        }

        if (context.ui.panel.current()?.name === PANEL) {
          context.ui.panel.close();
        }

        setState("pasting");
        await deliverText(context, value);

        setLastText(value);
        void updateHistory((draft) => {
          draft.items.unshift({ text: value, at: Date.now() });
          draft.items = draft.items.slice(0, 20);
        });
        setPartial("");
        setState("idle");
      } catch (error) {
        if (requestGeneration === generation) {
          notify(error instanceof Error ? error.message : String(error), "error");
          setState("idle");
        }
      } finally {
        if (requestGeneration === generation) {
          active = undefined;
          clearElapsed();
        }
        starting = false;
      }
    }

    function stopListening() {
      if (state() !== "listening" || !active) return;
      setState("transcribing");
      clearElapsed();
      active.stop();
    }

    function cancelListening() {
      if (state() !== "listening" || !active) return;
      generation += 1;
      clearElapsed();
      active.cancel();
      active = undefined;
      setState("idle");
      setPartial("");
      setLevels([]);
    }

    function toggle() {
      if (state() === "listening") {
        stopListening();
        return;
      }
      if (state() === "transcribing" || state() === "pasting") return;
      void startListening();
    }

    let lastToggleAt = 0;
    function toggleGuarded() {
      const now = Date.now();
      if (now - lastToggleAt < 180) return;
      lastToggleAt = now;
      toggle();
    }

    let lastPanelAt = 0;
    function openPanelGuarded() {
      const now = Date.now();
      if (now - lastPanelAt < 200) return;
      lastPanelAt = now;
      void openPanel();
    }

    async function speakLastReply() {
      const route = context.ui.router.current();
      if (route.type !== "session") {
        notify("请先打开一个会话。", "warning");
        return;
      }
      if (state() === "listening" || state() === "transcribing") {
        notify("请先结束录音。", "warning");
        return;
      }
      try {
        let messages = context.data.session.message.list(route.sessionID);
        if (!messages || messages.length === 0) {
          await context.data.session.message.sync(route.sessionID);
          messages = context.data.session.message.list(route.sessionID);
        }
        const text = lastAssistantText(messages ?? []);
        if (!text) {
          notify("还没有可朗读的回复。", "warning");
          return;
        }
        speaker.speak(text);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }

    function clearHistory() {
      void updateHistory((draft) => {
        draft.items = [];
      });
    }

    async function openPanel() {
      setPanelTab("voice");
      if (context.ui.router.current().type !== "session") {
        const sessionID = await ensureSession(context);
        if (!sessionID) return;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      if (!context.ui.panel.open(PANEL)) {
        notify("请先打开一个会话。", "warning");
      }
    }

    async function refreshGoUsage() {
      try {
        const location = context.location ?? context.data.location.default();
        const response = await context.client.experimental.usage.limits({ location });
        const meter = response.data?.go?.rolling;
        setGoUsage(meter ? { percent: meter.percent, limited: meter.limited } : null);
      } catch {
        setGoUsage(null);
      }
    }

    async function openUsagePanel() {
      if (context.ui.router.current().type !== "session") {
        const sessionID = await ensureSession(context);
        if (!sessionID) return;
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
      if (context.ui.panel.current()?.name === PANEL) {
        context.ui.panel.close();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      setPanelTab("usage");
      context.ui.panel.open(PANEL);
    }

    void refreshGoUsage();
    const usageTimer = setInterval(() => void refreshGoUsage(), 60_000);
    cleanups.push(() => clearInterval(usageTimer));

    const controller: Controller = {
      state,
      levels,
      elapsed,
      partial,
      lastText,
      history: () => history.items,
      maxSeconds: settings.maxSeconds,
      shortcutLabel: displayKey(settings.toggleKeybind),
      panelShortcutLabel: displayKey(settings.panelKeybind),
      toggle: toggleGuarded,
      speakLast: () => void speakLastReply(),
      stopSpeaking: () => speaker.stop(),
      clearHistory,
    };
    setDebugStage("controller");

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer",
      render: (input) => {
        if (input.mode === "shell") return null;
        const label = () => {
          switch (state()) {
            case "listening":
              return `● ${duration(elapsed())}`;
            case "transcribing":
              return "◌ 识别";
            case "pasting":
              return "… 填入";
            case "speaking":
              return "▶ 朗读";
            default:
              return "○ 语音";
          }
        };
        const color = () => {
          if (state() === "listening") return context.theme.text.feedback.error.base;
          if (state() === "transcribing" || state() === "pasting") return context.theme.text.feedback.warning.base;
          if (state() === "speaking") return context.theme.text.feedback.success.base;
          return context.theme.text.muted;
        };
        return (
          <text
            fg={color()}
            onMouseDown={() => toggleGuarded()}
          >
            {` ${displayKey(settings.toggleKeybind)}  [  ${label()}  ]  ${displayKey(settings.panelKeybind)} 面板${settings.debug ? ` [${debugStage()}]` : ""} `}
          </text>
        );
      },
    });

    const renderGoUsage = () => {
      const usage = goUsage();
      const percent = usage?.percent ?? 0;
      const color = () => {
        if (!usage) return context.theme.text.muted;
        if (usage.limited || percent >= 85) return context.theme.text.feedback.error.base;
        if (percent >= 60) return context.theme.text.feedback.warning.base;
        return context.theme.text.feedback.success.base;
      };
      return (
        <text fg={color()} onMouseDown={() => void openUsagePanel()}>
          {` Go 5h ${progressBar(percent, 8)} ${usage ? `${Math.round(percent)}%` : "--"} `}
        </text>
      );
    };
    const unregisterGoPrompt = context.ui.slot({
      append: "prompt.footer.status",
      render: renderGoUsage,
    });
    const unregisterGoHome = context.ui.slot({
      append: "home.footer.status",
      render: renderGoUsage,
    });

    const unregisterComposer = context.ui.slot({
      append: "session.composer.top",
      render: () => {
        if (state() !== "listening" && state() !== "transcribing") return null;
        const width = Math.max(20, Math.min(52, context.renderer.width - 12));
        return (
          <box flexDirection="column">
            <text fg={state() === "listening" ? context.theme.text.feedback.error.base : context.theme.text.feedback.warning.base}>
              {waveform(levels(), width)} {duration(elapsed())}/{settings.maxSeconds}s
            </text>
            <text fg={context.theme.text.muted}>
              {oneLine(partial() || (state() === "transcribing" ? "识别中…" : "正在聆听…"), width + 8)}
            </text>
          </box>
        );
      },
    });
    setDebugStage("composer");

    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <Dashboard context={context} panel={panel} controller={controller} initialTab={panelTab()} />
        </Show>
      ),
    });
    setDebugStage("panel");

    try {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 20,
        commands: [
          {
            id: "voice.dictate",
            title: "Voice: 开始/停止录音",
            description: "点击麦克风或按快捷键开关",
            group: "Voice",
            palette: true,
            slash: { name: "voice" },
            suggested: true,
            run: toggleGuarded,
          },
          {
            id: "voice.toggle",
            title: "Voice: 快捷键开始/停止录音",
            description: "按一次开始，再按一次停止；不需要长按",
            group: "Voice",
            bind: settings.toggleKeybind,
            palette: true,
            slash: { name: "voice-toggle" },
            run: toggleGuarded,
          },
          {
            id: "voice.toggle.f9",
            title: "Voice: F9 开始/停止录音",
            description: "备用快捷键，适合不发送 Ctrl+Shift 的终端",
            group: "Voice",
            bind: "f9",
            palette: true,
            run: toggleGuarded,
          },
          {
            id: "voice.usage",
            title: "Voice: 打开 Go 用量",
            description: "直接打开控制面板的 Usage 页签",
            group: "Voice",
            palette: true,
            slash: { name: "voice-usage" },
            run: () => void openUsagePanel(),
          },
          {
            id: "voice.panel",
            title: "Voice: 打开控制面板",
            description: "语音、Go 额度与项目",
            group: "Voice",
            bind: settings.panelKeybind,
            palette: true,
            slash: { name: "voice-panel" },
            run: openPanelGuarded,
          },
          {
            id: "voice.panel.f10",
            title: "Voice: F10 打开控制面板",
            description: "备用快捷键",
            group: "Voice",
            bind: "f10",
            palette: true,
            run: openPanelGuarded,
          },
          {
            id: "voice.speak",
            title: "Voice: 朗读上一条回复",
            group: "Voice",
            palette: true,
            slash: { name: "voice-speak" },
            run: () => void speakLastReply(),
          },
          {
            id: "voice.stop-speaking",
            title: "Voice: 停止朗读",
            group: "Voice",
            palette: true,
            run: () => speaker.stop(),
          },
        ],
      }));
    } catch (error) {
      notify(`命令注册失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    setDebugStage("keymap");

    if (settings.autoSpeak) {
      cleanups.push(
        context.data.on("session.execution.succeeded", (event) => {
          if (state() === "listening" || state() === "transcribing" || state() === "pasting") return;
          const route = context.ui.router.current();
          if (route.type !== "session") return;
          try {
            if (context.data.session.root(route.sessionID) !== context.data.session.root(event.data.sessionID)) return;
          } catch {
            return;
          }
          setTimeout(() => void speakLastReply(), 250);
        }),
      );
    }

    try {
      const keyInput = context.renderer.keyInput as unknown as {
        prependListener(event: "keypress" | "keyrelease", handler: (event: KeyEvent) => void): void;
        off(event: "keypress" | "keyrelease", handler: (event: KeyEvent) => void): void;
      };

      const onPress = (event: KeyEvent) => {
        if (event.eventType === "release") return;
        if (context.keymap.mode.current() === "modal") return;
        if (process.env.OPENCODE_VOICE_DEBUG_KEYS === "1") {
          context.ui.toast.show({
            title: "Voice key",
            message: `${event.name} ctrl=${event.ctrl} shift=${event.shift} alt=${event.option} super=${Boolean(event.super)}`,
            duration: 1200,
          });
        }

        if (matches(event, settings.toggleKeybind)) {
          event.preventDefault();
          event.stopPropagation();
          toggleGuarded();
          return;
        }

        if (matches(event, settings.panelKeybind)) {
          event.preventDefault();
          event.stopPropagation();
          openPanelGuarded();
          return;
        }

        if (event.name === "f9") {
          event.preventDefault();
          event.stopPropagation();
          toggleGuarded();
          return;
        }

        if (event.name === "f10") {
          event.preventDefault();
          event.stopPropagation();
          openPanelGuarded();
          return;
        }

        if (matches(event, settings.keybind)) {
          event.preventDefault();
          event.stopPropagation();
          if (state() === "listening") stopListening();
          else if (state() !== "transcribing" && state() !== "pasting") void startListening();
          return;
        }

        if (event.name === "escape" && state() === "listening") {
          event.preventDefault();
          event.stopPropagation();
          cancelListening();
        }
      };

      const onRelease = (event: KeyEvent) => {
        if (!matches(event, settings.keybind)) return;
        event.preventDefault();
        event.stopPropagation();
        if (state() === "listening") stopListening();
      };

      keyInput.prependListener("keypress", onPress);
      keyInput.prependListener("keyrelease", onRelease);
      cleanups.push(() => {
        keyInput.off("keypress", onPress);
        keyInput.off("keyrelease", onRelease);
      });
    } catch (error) {
      notify(`快捷键注册失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    setDebugStage("keys");

    if (settings.debug) {
      notify("Voice: debug auto-panel in 2.5s", "info");
      setTimeout(() => {
        void (async () => {
          const sessionID = await ensureSession(context);
          if (!sessionID) return;
          setTimeout(() => context.ui.panel.open(PANEL), 800);
        })();
      }, 2500);
    }

    const debugPaste = process.env.OPENCODE_VOICE_DEBUG_PASTE;
    if (debugPaste) {
      setTimeout(() => {
        void (async () => {
          const sessionID = await ensureSession(context);
          if (!sessionID) return;
          if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close();
          await new Promise((resolve) => setTimeout(resolve, 300));
          await deliverText(context, debugPaste);
        })();
      }, 5000);
    }

    if (process.env.OPENCODE_VOICE_DEBUG_RECORD === "1") {
      setTimeout(() => void startListening(), 3000);
      setTimeout(() => stopListening(), 11000);
    }
    setDebugStage("ready");

    return async () => {
      cleanups.forEach((cleanup) => cleanup());
      unregisterFooter();
      unregisterGoPrompt();
      unregisterGoHome();
      unregisterComposer();
      unregisterPanel();
      generation += 1;
      clearElapsed();
      active?.cancel();
      active = undefined;
      speaker.stop();
    };
  },
});
