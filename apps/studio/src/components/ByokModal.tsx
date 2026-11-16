import { useState } from "react";
import { SceneValidationError, parseScene } from "@hyperstage/core";
import type { SceneAST } from "@hyperstage/core";
import { autoFixScene } from "@hyperstage/spatial-linter";
import type { AutoFixResult } from "@hyperstage/spatial-linter";

export type Provider = "gemini" | "mistral";

export interface ByokModalProps {
  open: boolean;
  onClose: () => void;
  onAccept: (scene: SceneAST, result: AutoFixResult) => void;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

const MAX_ITERATIONS = 3;
const DEFAULT_MODELS: Record<Provider, string> = { gemini: "gemini-2.5-flash", mistral: "mistral-large-latest" };
const storageKey = (provider: Provider): string => `hyperstage.byok.${provider}`;

export const SYSTEM_PROMPT = `You are a HyperStage world generator. Reply with ONE JSON object only (no prose, no markdown) matching:
SceneAST = { name: string, gravity: [x,y,z] (use [0,-9.81,0]), skyColor: "#08090A", nodes: SceneNode[] }
SceneNode is one of:
 { kind:"box", id, size:[x,y,z], position?, rotationDeg?, snapTo?, material?, physics? }
 { kind:"sphere", id, radius, ...same optional fields }
 { kind:"cylinder", id, radiusTop, radiusBottom, height, ...same optional fields }
 { kind:"ramp", id, size:[length,thickness,width], angleDeg, ...same optional fields }
 { kind:"camera", id, position:[x,y,z], target:[x,y,z], fov?, isHero? }
 { kind:"light", id, position:[x,y,z], intensity, color?, castShadow? }
 { kind:"spawn", id, position:[x,y,z] } and { kind:"goal", id, position:[x,y,z], radius }
snapTo = { target: nodeId, face: "top"|"bottom"|"north"|"south"|"east"|"west", align?: "center"|"min"|"max", offset?: [x,y,z] }
material = { color:"#rrggbb", metalness?, roughness?, opacity? } ; physics = { body:"static"|"dynamic"|"kinematic", mass?, restitution?, friction?, allowTip? }
Rules: y is up; give one ground box an absolute position and place everything else with snapTo so surfaces touch at 0.000 m; never create snapTo cycles;
dynamic bodies must rest on a surface or start on a ramp; include one hero camera (isHero:true) with a clear view and one light with castShadow:true;
ids are kebab-case and unique; at most 60 nodes.`;

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model reply did not contain a JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

function readPath(value: unknown, path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

async function callModel(provider: Provider, apiKey: string, model: string, turns: ChatTurn[]): Promise<string> {
  if (provider === "gemini") {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
    });
    const json: unknown = await response.json();
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${String(readPath(json, ["error", "message"]) ?? response.statusText)}`);
    const parts = readPath(json, ["candidates", 0, "content", "parts"]);
    if (!Array.isArray(parts)) throw new Error("Gemini returned no candidates");
    return parts.map((p) => String(readPath(p, ["text"]) ?? "")).join("");
  }
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
    }),
  });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`Mistral ${response.status}: ${String(readPath(json, ["message"]) ?? readPath(json, ["error", "message"]) ?? response.statusText)}`);
  const content = readPath(json, ["choices", 0, "message", "content"]);
  if (typeof content !== "string") throw new Error("Mistral returned no message content");
  return content;
}

/** Client-side BYOK world generator: Generate -> Lint -> Auto-Repair, up to 3 model iterations. */
export function ByokModal({ open, onClose, onAccept }: ByokModalProps) {
  const [provider, setProvider] = useState<Provider>(() => (localStorage.getItem("hyperstage.byok.provider") === "mistral" ? "mistral" : "gemini"));
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(storageKey(provider)) ?? "");
  const [model, setModel] = useState<string>(DEFAULT_MODELS[provider]);
  const [prompt, setPrompt] = useState("A small floating island temple with a ramp, three marbles and a domino run");
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  if (!open) return null;

  const switchProvider = (next: Provider) => {
    setProvider(next);
    setModel(DEFAULT_MODELS[next]);
    setApiKey(localStorage.getItem(storageKey(next)) ?? "");
    localStorage.setItem("hyperstage.byok.provider", next);
  };

  const append = (line: string) => setLog((prev) => [...prev, line]);

  const generate = async () => {
    if (apiKey.trim() === "") {
      append("✖ add an API key first (stored only in this browser's localStorage)");
      return;
    }
    localStorage.setItem(storageKey(provider), apiKey.trim());
    setRunning(true);
    setLog([]);
    const turns: ChatTurn[] = [{ role: "user", text: prompt }];
    let best: { scene: SceneAST; result: AutoFixResult } | null = null;
    try {
      for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
        append(`→ iteration ${iteration}/${MAX_ITERATIONS}: generating with ${provider} (${model})…`);
        const reply = await callModel(provider, apiKey.trim(), model, turns);
        turns.push({ role: "assistant", text: reply });
        let scene: SceneAST;
        try {
          scene = parseScene(extractJson(reply));
        } catch (error) {
          const detail = error instanceof SceneValidationError ? error.issues.slice(0, 10).map((i) => `${i.path}: ${i.message}`).join("; ") : error instanceof Error ? error.message : String(error);
          append(`  ✖ schema: ${detail}`);
          turns.push({ role: "user", text: `Your JSON failed schema validation: ${detail}. Return the full corrected SceneAST JSON only.` });
          continue;
        }
        append(`  ✓ parsed ${scene.nodes.length} nodes — linting + auto-repair…`);
        const result = await autoFixScene(scene);
        best = { scene: result.scene, result };
        append(`  lint: ${result.initialReport.diagnostics.length} diagnostic(s) → ${result.report.diagnostics.length} after ${result.passes} repair pass(es) in ${result.report.elapsedMs.toFixed(1)} ms`);
        if (result.report.valid) {
          append("✔ valid scene — loaded into the editor");
          onAccept(result.scene, result);
          return;
        }
        const remaining = result.report.diagnostics.map((d) => `${d.code} ${d.nodeId}: ${d.message}`).join("\n");
        turns.push({ role: "user", text: `The spatial linter still reports:\n${remaining}\nReturn the full corrected SceneAST JSON only.` });
      }
      if (best !== null) {
        append("▲ loaded the best attempt; remaining diagnostics are shown in the panel");
        onAccept(best.scene, best.result);
      } else {
        append("✖ no valid scene after 3 iterations");
      }
    } catch (error) {
      append(`✖ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="hs-drawer-backdrop" onClick={onClose} />
      <aside className="hs-drawer" role="dialog" aria-label="AI world generator">
        <div className="hs-pane-head">
          AI World Generator
          <span className="hs-badge hs-badge-cyan">BYOK</span>
          <span className="hs-spacer" />
          <button type="button" className="hs-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="hs-drawer-body">
          <div className="hs-segment" role="group" aria-label="Provider">
            <button type="button" aria-pressed={provider === "gemini"} onClick={() => switchProvider("gemini")}>
              Gemini
            </button>
            <button type="button" aria-pressed={provider === "mistral"} onClick={() => switchProvider("mistral")}>
              Mistral
            </button>
          </div>
          <label className="hs-field">
            API key
            <input className="hs-input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider === "gemini" ? "AIza…" : "Mistral API key"} />
          </label>
          <label className="hs-field">
            Model
            <input className="hs-input" value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="hs-field">
            Describe the world
            <textarea className="hs-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <button type="button" className="hs-btn hs-btn-primary" onClick={() => void generate()} disabled={running}>
            {running ? "Generating…" : "Generate → Lint → Auto-Repair"}
          </button>
          <p className="hs-note">
            Requests go straight from this browser to {provider === "gemini" ? "generativelanguage.googleapis.com" : "api.mistral.ai"}. Your key stays in localStorage on this device.
          </p>
          {log.length > 0 && <div className="hs-card hs-log">{log.join("\n")}</div>}
        </div>
      </aside>
    </>
  );
}
