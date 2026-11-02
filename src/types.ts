export type VoiceState = "idle" | "listening" | "transcribing" | "pasting" | "speaking";
export type PanelTab = "voice" | "project" | "usage";

export interface HistoryItem {
  text: string;
  at: number;
}

export interface Controller {
  state: () => VoiceState;
  levels: () => number[];
  elapsed: () => number;
  partial: () => string;
  lastText: () => string;
  history: () => HistoryItem[];
  maxSeconds: number;
  shortcutLabel: string;
  panelShortcutLabel: string;
  toggle: () => void;
  speakLast: () => void;
  stopSpeaking: () => void;
  clearHistory: () => void;
}
