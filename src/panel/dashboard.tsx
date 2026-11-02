import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { PanelInput, Context } from "@opencode/plugin/tui/context";
import type { Project, UsageLimitsInfo } from "@opencode/client";
import type { Controller, PanelTab } from "../types.js";
import { palette } from "../theme.js";
import { clock, compactNumber, duration, money, oneLine, progressBar, resetAt } from "../format.js";
import { spawn } from "node:child_process";

type Tab = PanelTab;
const TABS: Tab[] = ["voice", "project", "usage"];

const TAB_LABELS: Record<Tab, string> = {
  voice: "1 Voice",
  project: "2 Project",
  usage: "3 Usage",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waveformRows(levels: readonly number[], rows: number, columns: number): string[] {
  const size = Math.max(8, columns);
  if (levels.length === 0) {
    return Array.from({ length: rows }, (_, index) =>
      index === rows - 1 ? "▁".repeat(size) : " ".repeat(size),
    );
  }
  const tail = levels.slice(-size);
  const padded = [...Array(Math.max(0, size - tail.length)).fill(0), ...tail];
  return Array.from({ length: rows }, (_, index) => {
    const threshold = rows - index;
    return padded.map((level) => (Math.round(level * rows) >= threshold ? "█" : " ")).join("");
  });
}

export function Dashboard(props: {
  context: Context;
  panel: PanelInput;
  controller: Controller;
  initialTab?: PanelTab;
}) {
  const context = props.context;
  const controller = props.controller;
  const theme = context.theme;
  const panel = props.panel;

  const location = () => context.location ?? context.data.location.default();
  const width = () => Math.max(28, panel.width - 4);
  const accent = palette.accent;

  const [tab, setTab] = createSignal<Tab>("voice");
  createEffect(() => {
    const next = props.initialTab;
    if (next) setTab(next);
  });

  const [quota, setQuota] = createSignal<UsageLimitsInfo | null>(null);
  const [quotaError, setQuotaError] = createSignal("");
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [projectIndex, setProjectIndex] = createSignal(0);
  const [projectError, setProjectError] = createSignal("");
  const [branch, setBranch] = createSignal("");

  const session = () => {
    try {
      return context.data.session.get(panel.sessionID);
    } catch {
      return undefined;
    }
  };

  const sessionStatus = () => {
    try {
      return context.data.session.status(panel.sessionID);
    } catch {
      return "idle";
    }
  };

  const modelLabel = () => {
    const model = session()?.model;
    if (model) return `${model.providerID}/${model.id}`;
    const current = context.ui.model.current();
    return current ? `${current.providerID}/${current.modelID}` : "—";
  };

  const agentLabel = () => session()?.agent ?? "—";

  const tokenTotal = () => {
    const tokens = session()?.tokens;
    if (!tokens) return 0;
    return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  };

  const currentProject = () => {
    const directory = location().directory;
    return projects().find(
      (project) => directory === project.canonical || directory.startsWith(`${project.canonical}/`),
    );
  };

  const projectLabel = () =>
    currentProject()?.name ??
    location().directory.split("/").filter(Boolean).at(-1) ??
    location().directory;

  const rolling = () => quota()?.go?.rolling;
  const rollingPercent = () => rolling()?.percent ?? 0;

  async function loadQuota() {
    try {
      const response = await context.client.experimental.usage.limits({ location: location() });
      setQuota(response.data);
      setQuotaError("");
    } catch (error) {
      setQuotaError(message(error));
    }
  }

  async function loadProjects() {
    try {
      await context.data.project.sync();
      const list = [...context.data.project.list()].sort((left, right) => right.time.updated - left.time.updated);
      setProjects(list);
      const index = list.findIndex(
        (project) =>
          location().directory === project.canonical || location().directory.startsWith(`${project.canonical}/`),
      );
      if (index >= 0) setProjectIndex(index);
      setProjectError("");
      try {
        await context.data.location.vcs.sync(location());
        setBranch(context.data.location.vcs.info(location())?.branch.current ?? "");
      } catch {
        setBranch("");
      }
    } catch (error) {
      setProjectError(message(error));
    }
  }

  function refresh(next: Tab) {
    if (next === "usage") void loadQuota();
    if (next === "project") void loadProjects();
  }

  function selectTab(next: Tab) {
    setTab(next);
    refresh(next);
  }

  function cycleTab(direction: number) {
    const index = TABS.indexOf(tab());
    selectTab(TABS[(index + direction + TABS.length) % TABS.length]!);
  }

  function move(direction: number) {
    if (tab() !== "project") return;
    const size = projects().length;
    if (size === 0) return;
    setProjectIndex((index) => (index + direction + size) % size);
  }

  async function openProject(index = projectIndex()) {
    const project = projects()[index];
    if (!project) return;
    try {
      const sessions = await context.client.session.list({
        directory: project.canonical,
        limit: 1,
        order: "desc",
      });
      const existing = sessions.data[0];
      if (existing) {
        context.ui.router.navigate({ type: "session", sessionID: existing.id });
      } else {
        const created = await context.client.session.create({
          location: { directory: project.canonical },
        });
        context.ui.router.navigate({ type: "session", sessionID: created.id });
      }
      panel.close();
    } catch (error) {
      context.ui.toast.show({ title: "Project", message: message(error), variant: "error" });
    }
  }

  function openProjectMenu() {
    const available = context.keymap.commands().some((command) => command.id === "open.menu");
    panel.close();
    if (!available) {
      context.ui.toast.show({
        title: "Project",
        message: "当前版本没有可用的项目菜单",
        variant: "warning",
      });
      return;
    }
    setTimeout(() => context.keymap.dispatch("open.menu"), 60);
  }

  function openUsage() {
    const url = quota()?.workspace.usageURL;
    if (!url) return;
    try {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } catch (error) {
      context.ui.toast.show({ title: "Usage", message: message(error), variant: "error" });
    }
  }

  function act() {
    if (tab() === "voice") controller.toggle();
    else if (tab() === "project") void openProject();
    else openUsage();
  }

  context.keymap.layer(() => ({
    mode: "global",
    enabled: () => panel.focused,
    priority: 20,
    commands: [
      { id: "voice.panel.tab.voice", title: "Voice tab", bind: "1", run: () => selectTab("voice") },
      { id: "voice.panel.tab.project", title: "Project tab", bind: "2", run: () => selectTab("project") },
      { id: "voice.panel.tab.usage", title: "Usage tab", bind: "3", run: () => selectTab("usage") },
      { id: "voice.panel.tab.next", title: "Next tab", bind: "tab", run: () => cycleTab(1) },
      { id: "voice.panel.tab.previous", title: "Previous tab", bind: "shift+tab", run: () => cycleTab(-1) },
      { id: "voice.panel.down", title: "Down", bind: "j", run: () => move(1) },
      { id: "voice.panel.up", title: "Up", bind: "k", run: () => move(-1) },
      { id: "voice.panel.enter", title: "Open", bind: "return", run: act },
      { id: "voice.panel.record", title: "Record", bind: "r", run: () => controller.toggle() },
      { id: "voice.panel.speak", title: "Speak last reply", bind: "s", run: () => controller.speakLast() },
      { id: "voice.panel.stop", title: "Stop speaking", bind: "x", run: () => controller.stopSpeaking() },
      { id: "voice.panel.clear", title: "Clear voice history", bind: "c", run: () => controller.clearHistory() },
      { id: "voice.panel.projects", title: "Recent projects", bind: "p", run: () => openProjectMenu() },
      { id: "voice.panel.usage", title: "Open usage page", bind: "u", run: () => openUsage() },
      { id: "voice.panel.close", title: "Close panel", bind: "escape", run: () => panel.close() },
      { id: "voice.panel.close.q", title: "Close panel", bind: "q", run: () => panel.close() },
    ],
  }));

  onMount(() => {
    void loadQuota();
    void loadProjects();

    const debugTab = process.env.OPENCODE_VOICE_DEBUG_TAB as Tab | undefined;
    const debugTimer =
      debugTab && TABS.includes(debugTab)
        ? setTimeout(() => selectTab(debugTab), 300)
        : undefined;
    const timer = setInterval(() => void loadQuota(), 30_000);

    onCleanup(() => {
      clearInterval(timer);
      if (debugTimer) clearTimeout(debugTimer);
    });
  });

  const stateLabel = () => {
    switch (controller.state()) {
      case "listening":
        return "● LISTENING";
      case "transcribing":
        return "◌ TRANSCRIBING";
      case "pasting":
        return "… INSERTING";
      case "speaking":
        return "▶ SPEAKING";
      default:
        return "○ IDLE";
    }
  };

  const stateColor = () => {
    switch (controller.state()) {
      case "listening":
        return palette.error;
      case "transcribing":
      case "pasting":
        return palette.warning;
      case "speaking":
        return palette.success;
      default:
        return theme.text.muted;
    }
  };

  const tall = () => context.renderer.height >= 36;

  return (
    <box flexDirection="column" height="100%" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexDirection="row">
        <text fg={accent} attributes={TextAttributes.BOLD}>VOICE ASSISTANT</text>
        <Show when={sessionStatus() === "running"}>
          <text fg={palette.success} attributes={TextAttributes.BOLD}>{"  "}● RUNNING</text>
        </Show>
        <text fg={theme.text.muted}>{"   "}{controller.panelShortcutLabel} panel</text>
      </box>
      <text fg={theme.text.muted}>
        {oneLine(
          `${session()?.title ?? "Untitled session"}  ·  ${projectLabel()}${branch() ? `  ·  ${branch()}` : ""}`,
          width(),
        )}
      </text>
      <text fg={theme.text.muted}>{"─".repeat(Math.max(10, width() - 2))}</text>

      <box flexDirection="row">
        <For each={TABS}>
          {(item) => (
            <text fg={tab() === item ? accent : theme.text.muted} attributes={tab() === item ? TextAttributes.BOLD : undefined}>
              {tab() === item ? `▸ ${TAB_LABELS[item]}   ` : `  ${TAB_LABELS[item]}   `}
            </text>
          )}
        </For>
      </box>
      <text fg={theme.text.muted}>{"─".repeat(Math.max(10, width() - 2))}</text>

      <Show when={tab() === "voice"}>
        <box flexDirection="column">
          <box flexDirection="row" marginTop={1}>
            <text fg={stateColor()} attributes={TextAttributes.BOLD}>{stateLabel()}</text>
            <text fg={theme.text.muted}>{"   "}{duration(controller.elapsed())} / {duration(controller.maxSeconds)}</text>
            <text fg={theme.text.muted}>{"   Go 5h "}</text>
            <text fg={accent}>{progressBar(rollingPercent(), 8)}</text>
            <text fg={theme.text.base}> {Math.round(rollingPercent())}%</text>
          </box>

          <box flexDirection="column">
            <For each={waveformRows(controller.levels(), tall() ? 4 : 2, Math.max(16, width() - 2))}>
              {(line) => (
                <text fg={controller.state() === "listening" ? accent : theme.text.muted}>{line}</text>
              )}
            </For>
          </box>

          <box flexDirection="row">
            <text fg={theme.text.muted}>MAX  </text>
            <text fg={accent}>{progressBar((controller.elapsed() / controller.maxSeconds) * 100, 18)}</text>
            <text fg={theme.text.muted}> {Math.round((controller.elapsed() / controller.maxSeconds) * 100)}%</text>
          </box>

          <box flexDirection="row">
            <text fg={theme.text.muted}>LIVE  </text>
            <text fg={theme.text.base}>{oneLine(controller.partial() || "—", width() - 6)}</text>
          </box>
          <box flexDirection="row">
            <text fg={theme.text.muted}>LAST  </text>
            <text fg={palette.success}>{oneLine(controller.lastText() || "—", width() - 6)}</text>
          </box>

          <text fg={theme.text.muted} marginTop={1}>SESSION</text>
          <box flexDirection="row">
            <text fg={theme.text.muted}>model  </text>
            <text fg={theme.text.base}>{oneLine(modelLabel(), Math.max(8, width() - 8))}</text>
          </box>
          <box flexDirection="row">
            <text fg={theme.text.muted}>agent  </text>
            <text fg={theme.text.base}>{oneLine(agentLabel(), 12)}</text>
            <text fg={theme.text.muted}>   tokens  </text>
            <text fg={accent}>{compactNumber(tokenTotal())}</text>
            <text fg={theme.text.muted}>   cost  </text>
            <text fg={palette.success}>{money(session()?.cost ?? 0)}</text>
          </box>

          <text fg={theme.text.muted} marginTop={1}>HISTORY</text>
          <Show
            when={controller.history().length > 0}
            fallback={
              <text fg={theme.text.muted}>
                {oneLine(`No voice history yet. Press ${controller.shortcutLabel} to record.`, width())}
              </text>
            }
          >
            <For each={controller.history().slice(0, tall() ? 4 : 2)}>
              {(item) => (
                <box flexDirection="row">
                  <text fg={theme.text.muted}>{clock(item.at)}  </text>
                  <text fg={accent}>›</text>
                  <text fg={theme.text.base}> {oneLine(item.text, width() - 12)}</text>
                </box>
              )}
            </For>
          </Show>

          <box flexGrow={1} />
          <text fg={theme.text.muted}>
            [r] rec   [s] speak   [x] stop   [c] clear   ·   esc
          </text>
        </box>
      </Show>

      <Show when={tab() === "project"}>
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.text.muted}>CURRENT</text>
          <text fg={theme.text.base}>{oneLine(currentProject()?.name ?? location().directory, width())}</text>
          <text fg={theme.text.muted}>{oneLine(location().directory, width())}</text>
          <box flexDirection="row">
            <text fg={theme.text.muted}>branch  </text>
            <text fg={accent}>{branch() || "—"}</text>
          </box>

          <text fg={theme.text.muted} marginTop={1}>RECENT</text>
          <Show when={!projectError()} fallback={<text fg={palette.error}>{projectError()}</text>}>
            <For each={projects().slice(0, 6)}>
              {(project, index) => (
                <text fg={index() === projectIndex() ? accent : theme.text.base}>
                  {index() === projectIndex() ? "▸ " : "  "}
                  {oneLine(project.name ?? project.canonical, width() - 2)}
                </text>
              )}
            </For>
          </Show>

          <text fg={theme.text.muted} marginTop={1}>j/k select   enter open   p recent   esc close</text>
        </box>
      </Show>

      <Show when={tab() === "usage"}>
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.text.muted}>OPENCODE GO</text>
          <text fg={theme.text.base}>{quota()?.workspace.name ?? "workspace"}</text>
          <Show when={!quotaError()} fallback={<text fg={palette.error}>{quotaError()}</text>}>
            <Show when={quota()?.go} fallback={<text fg={theme.text.muted}>Go 额度不可用（未登录或服务不可用）</text>}>
              <For
                each={[
                  ["5h", quota()?.go?.rolling, accent],
                  ["week", quota()?.go?.weekly, palette.warning],
                  ["month", quota()?.go?.monthly, palette.success],
                ] as const}
              >
                {([label, meter, color]) => (
                  <Show when={meter}>
                    <box flexDirection="row" marginTop={1}>
                      <text fg={theme.text.muted}>{label.padEnd(6)}</text>
                      <text fg={color}>{progressBar(meter!.percent, 16)}</text>
                      <text fg={theme.text.base}> {Math.round(meter!.percent)}%</text>
                      <Show when={meter!.limited}>
                        <text fg={palette.error}> LIMITED</text>
                      </Show>
                      <text fg={theme.text.muted}>  reset {resetAt(meter!.resetsAt)}</text>
                    </box>
                  </Show>
                )}
              </For>
            </Show>
            <Show when={(quota()?.budgets?.length ?? 0) > 0}>
              <text fg={theme.text.muted} marginTop={1}>BUDGETS</text>
              <For each={quota()?.budgets ?? []}>
                {(budget) => (
                  <text fg={theme.text.muted}>
                    {budget.scope} limit {budget.limit} spent {budget.spent} reset {resetAt(budget.resetsAt)}
                  </text>
                )}
              </For>
            </Show>
          </Show>

          <text fg={theme.text.muted} marginTop={1}>u open usage   enter refresh   esc close</text>
        </box>
      </Show>
    </box>
  );
}
