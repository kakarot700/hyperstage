import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { filterCommands } from "../lib/commands";
import type { Command } from "../lib/commands";

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

export function Keycaps({ keys }: { keys: string[] }) {
  return (
    <span className="hs-kbds">
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} className="hs-kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** Raycast-style ⌘K launcher: fuzzy search, arrow-key navigation, Enter to run. */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const grouped = query.trim() === "";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (command: Command | undefined) => {
    if (command === undefined || command.disabled === true) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[active]);
    }
  };

  return (
    <div className="hs-palette-backdrop" onMouseDown={onClose} data-testid="command-palette">
      <div className="hs-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="hs-palette-input"
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commands"
          aria-controls="hs-palette-list"
          data-testid="command-input"
        />
        <div className="hs-palette-list" id="hs-palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <div className="hs-palette-empty">No matching commands</div>}
          {results.map((command, i) => {
            const prev = results[i - 1];
            const showGroup = grouped && (prev === undefined || prev.group !== command.group);
            return (
              <div key={command.id}>
                {showGroup && <div className="hs-palette-group">{command.group}</div>}
                <button
                  type="button"
                  role="option"
                  className="hs-palette-item"
                  aria-selected={i === active}
                  disabled={command.disabled === true}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(command)}
                  data-testid={`cmd-${command.id}`}
                >
                  <span className="hs-palette-item-title">{command.title}</span>
                  {command.hint !== undefined && <span className="hs-palette-item-hint">{command.hint}</span>}
                  {command.keys.length > 0 && <Keycaps keys={command.keys} />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hs-palette-foot">
          <span>
            <Keycaps keys={["↑", "↓"]} /> navigate
          </span>
          <span>
            <Keycaps keys={["↵"]} /> run
          </span>
          <span>
            <Keycaps keys={["Esc"]} /> close
          </span>
        </div>
      </div>
    </div>
  );
}
