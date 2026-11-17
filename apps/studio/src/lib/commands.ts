export type CommandGroup = "Presets" | "Spatial" | "View" | "Camera" | "File";

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Keycap labels shown on the right, e.g. ["⌘", "K"] or ["1"]. */
  keys: string[];
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Subsequence fuzzy score: every query character must appear in order. Consecutive runs and
 * word-start hits score higher; returns -1 for no match. An empty query matches everything.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    const wordStart = found === 0 || /[\s\-·./]/.test(t[found - 1] ?? "");
    run = found === ti ? run + 1 : 1;
    score += 1 + run * 2 + (wordStart ? 4 : 0) - Math.min(3, found - ti) * 0.25;
    ti = found + 1;
  }
  return score;
}

/** Filters and ranks commands; ties keep their declared order. */
export function filterCommands<T extends Pick<Command, "title" | "group" | "hint">>(commands: T[], query: string): T[] {
  if (query.trim() === "") return commands;
  return commands
    .map((command, index) => ({ command, index, score: Math.max(fuzzyScore(query, command.title), fuzzyScore(query, `${command.group} ${command.title} ${command.hint ?? ""}`) - 2) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** True when a keyboard event originates from a text field, where single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable;
}

export const isMacPlatform = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
