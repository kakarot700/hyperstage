import { useEffect, useMemo, useRef, useState } from "react";
import { PLAYBACK_SPEEDS, formatTimeReadout, stepPlayback, timelineTicks } from "../lib/timeline";
import type { CollisionEvent, PlaybackSpeed } from "../lib/timeline";

export interface TimelineBarProps {
  frameCount: number;
  frame: number;
  playing: boolean;
  /** Impact markers detected in the rollout. */
  events: CollisionEvent[];
  onFrame: (frame: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

/** 60 Hz Rapier rollout playback: custom scrub track, tick markers, collision dots and speed control. */
export function TimelineBar({ frameCount, frame, playing, events, onFrame, onPlayingChange }: TimelineBarProps) {
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useEffect(() => {
    if (!playing || frameCount === 0) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      const step = stepPlayback(acc, (now - last) / 1000, speed);
      acc = step.accumulator;
      last = now;
      if (step.steps > 0) {
        const next = frameRef.current + step.steps;
        if (next >= frameCount) {
          onFrame(frameCount - 1);
          onPlayingChange(false);
          return;
        }
        onFrame(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frameCount, speed, onFrame, onPlayingChange]);

  const max = Math.max(0, frameCount - 1);
  const current = Math.min(frame, max);
  const ticks = useMemo(() => timelineTicks(frameCount), [frameCount]);
  const progress = max === 0 ? 0 : current / max;

  return (
    <footer className="hs-timeline" aria-label="Physics timeline">
      <button
        type="button"
        className="hs-btn hs-play"
        onClick={() => {
          if (!playing && frame >= max) onFrame(0);
          onPlayingChange(!playing);
        }}
        disabled={frameCount === 0}
        data-testid="play"
        title="Play / pause (Space)"
      >
        {playing ? "❚❚ Pause" : "▶ Play"}
        <kbd className="hs-kbd hs-kbd-sm">␣</kbd>
      </button>
      <button
        type="button"
        className="hs-btn hs-btn-ghost"
        onClick={() => {
          onPlayingChange(false);
          onFrame(0);
        }}
        disabled={frameCount === 0}
        title="Rewind to tick 1"
        aria-label="Rewind"
      >
        ⟲
      </button>
      <div className="hs-track">
        <div className="hs-track-rail">
          <div className="hs-track-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        {ticks.map((t) => (
          <span key={t.frame} className="hs-track-tick" data-major={t.major} style={{ left: `${t.at * 100}%` }}>
            {t.major && t.frame > 0 && <span className="hs-track-tick-label">{Number((t.frame / 60).toFixed(2))}s</span>}
          </span>
        ))}
        {max > 0 &&
          events.map((e) => (
            <button
              key={e.frame}
              type="button"
              className="hs-track-event"
              style={{ left: `${(e.frame / max) * 100}%` }}
              title={`tick ${e.frame + 1} · impact Δv ${e.impulse.toFixed(2)} m/s · ${e.ids.join(", ")}`}
              aria-label={`Collision at tick ${e.frame + 1}`}
              onClick={() => {
                onPlayingChange(false);
                onFrame(e.frame);
              }}
              data-testid="collision-dot"
            />
          ))}
        <input
          className="hs-scrubber"
          type="range"
          min={0}
          max={max}
          step={1}
          value={current}
          onChange={(event) => {
            onPlayingChange(false);
            onFrame(Number(event.target.value));
          }}
          aria-label="Timeline scrubber"
          data-testid="scrubber"
        />
      </div>
      <div className="hs-speed" role="group" aria-label="Playback speed">
        {PLAYBACK_SPEEDS.map((s) => (
          <button key={s} type="button" aria-pressed={s === speed} onClick={() => setSpeed(s)} data-testid={`speed-${s}`}>
            {s}x
          </button>
        ))}
      </div>
      <span className="hs-ticks" data-testid="frame-label" title={`tick ${current + 1}/${frameCount}`}>
        {formatTimeReadout(current, frameCount)}
      </span>
    </footer>
  );
}
