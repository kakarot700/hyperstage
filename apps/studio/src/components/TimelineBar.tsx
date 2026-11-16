import { useEffect, useRef } from "react";

export interface TimelineBarProps {
  frameCount: number;
  frame: number;
  playing: boolean;
  onFrame: (frame: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

/** 180-frame Rapier physics playback (60 Hz) with play/pause and scrubbing. */
export function TimelineBar({ frameCount, frame, playing, onFrame, onPlayingChange }: TimelineBarProps) {
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useEffect(() => {
    if (!playing || frameCount === 0) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      let next = frameRef.current;
      while (acc >= 1 / 60) {
        acc -= 1 / 60;
        next += 1;
      }
      if (next !== frameRef.current) {
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
  }, [playing, frameCount, onFrame, onPlayingChange]);

  const max = Math.max(0, frameCount - 1);
  return (
    <footer className="hs-timeline" aria-label="Physics timeline">
      <button
        type="button"
        className="hs-btn"
        style={{ width: 76 }}
        onClick={() => {
          if (!playing && frame >= max) onFrame(0);
          onPlayingChange(!playing);
        }}
        disabled={frameCount === 0}
        data-testid="play"
      >
        {playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <button type="button" className="hs-btn" onClick={() => { onPlayingChange(false); onFrame(0); }} disabled={frameCount === 0}>
        ⟲
      </button>
      <input
        className="hs-scrubber"
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(frame, max)}
        onChange={(event) => {
          onPlayingChange(false);
          onFrame(Number(event.target.value));
        }}
        aria-label="Timeline scrubber"
        data-testid="scrubber"
      />
      <span className="hs-ticks" data-testid="frame-label">
        tick {String(Math.min(frame, max) + 1).padStart(3, "0")}/{frameCount} · {((Math.min(frame, max) + 1) / 60).toFixed(2)}s
      </span>
    </footer>
  );
}
