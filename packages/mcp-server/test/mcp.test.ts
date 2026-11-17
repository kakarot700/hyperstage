import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@hyperstage/core";

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

class StdioHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly rawLines: string[] = [];
  readonly stderr: string[] = [];
  private buffer = "";
  private nextId = 1;
  private readonly waiters = new Map<number, (msg: JsonRpcMessage) => void>();

  constructor() {
    this.child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", entry], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim() !== "") {
          this.rawLines.push(line);
          const message = JSON.parse(line) as JsonRpcMessage;
          if (message.id !== undefined) this.waiters.get(message.id)?.(message);
        }
        index = this.buffer.indexOf("\n");
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 50000);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const response = await this.request("tools/call", { name, arguments: args });
    expect(response.error).toBeUndefined();
    return response.result as unknown as ToolResult;
  }
}

const parkour = PRESETS.find((p) => p.id === "parkour-arena");
const broken = PRESETS.find((p) => p.id === "broken-tower");
if (parkour === undefined || broken === undefined) throw new Error("presets missing");
const parkourJson = JSON.stringify(parkour.scene);
const brokenJson = JSON.stringify(broken.scene);

let harness: StdioHarness;

beforeAll(async () => {
  harness = new StdioHarness();
  const init = await harness.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hyperstage-test", version: "1.0.0" },
  });
  expect(init.result?.serverInfo).toMatchObject({ name: "hyperstage", version: "1.1.0" });
  harness.notify("notifications/initialized");
});

afterAll(() => {
  harness.child.kill();
});

describe("hyperstage MCP server over stdio", () => {
  it("lists exactly the 5 tools with input schemas", async () => {
    const response = await harness.request("tools/list", {});
    const tools = (response.result?.tools ?? []) as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hyperstage_compile_and_lint",
      "hyperstage_export_html",
      "hyperstage_inspect_bounds",
      "hyperstage_simulate_physics",
      "hyperstage_test_playability",
    ]);
    for (const tool of tools) expect(tool.inputSchema.properties.sceneJson).toBeDefined();
  });

  it("hyperstage_compile_and_lint returns summary + diagnostics as content and structuredContent", async () => {
    const result = await harness.callTool("hyperstage_compile_and_lint", { sceneJson: brokenJson });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { summary: { valid: boolean; errorCount: number; elapsedMs: number }; diagnostics: unknown[] };
    expect(structured.summary.valid).toBe(false);
    expect(structured.summary.errorCount).toBe(3);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(structured);
  });

  it("hyperstage_inspect_bounds returns AABBs and clearances", async () => {
    const result = await harness.callTool("hyperstage_inspect_bounds", { sceneJson: brokenJson });
    const structured = result.structuredContent as { bounds: { id: string }[]; clearances: { a: string; b: string; clearanceMeters: number }[] };
    expect(structured.bounds.find((b) => b.id === "ground")).toBeDefined();
    const worst = structured.clearances[0];
    expect(worst?.clearanceMeters).toBeCloseTo(-0.3, 6);
  });

  it("hyperstage_simulate_physics returns final transforms and peak velocities", async () => {
    const result = await harness.callTool("hyperstage_simulate_physics", { sceneJson: brokenJson, ticks: 90 });
    const structured = result.structuredContent as { ticks: number; finalTransforms: Record<string, unknown>; peakVelocities: Record<string, { linear: number }> };
    expect(structured.ticks).toBe(90);
    expect(Object.keys(structured.finalTransforms)).toContain("block-4");
    expect(structured.peakVelocities["block-4"]?.linear).toBeGreaterThan(1);
  });

  it("hyperstage_test_playability returns a reachable path", async () => {
    const result = await harness.callTool("hyperstage_test_playability", { sceneJson: parkourJson });
    const structured = result.structuredContent as { reachable: boolean; pathLengthMeters: number; waypoints: unknown[] };
    expect(structured.reachable).toBe(true);
    expect(structured.pathLengthMeters).toBeGreaterThan(10);
    expect(structured.waypoints.length).toBeGreaterThan(3);
  });

  it("hyperstage_export_html returns a standalone document", async () => {
    const result = await harness.callTool("hyperstage_export_html", { sceneJson: parkourJson, title: "Arena Export" });
    const structured = result.structuredContent as { html: string; frameCount: number; title: string };
    expect(structured.title).toBe("Arena Export");
    expect(structured.frameCount).toBe(180);
    expect(structured.html.startsWith("<!doctype html>")).toBe(true);
    expect(structured.html).toContain('id="hs-three-core"');
    expect(structured.html).toContain("OrbitControls");
    expect(structured.html).toContain("KeyW");
    expect(structured.html).not.toMatch(/<script[^>]+src=/);
  });

  it("returns isError for domain errors instead of throwing across the protocol", async () => {
    const invalid = await harness.callTool("hyperstage_compile_and_lint", { sceneJson: "{not json" });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.content[0]?.text ?? "{}").error).toBe("SceneValidationError");

    const cyclic = JSON.stringify({
      name: "cycle",
      gravity: [0, -9.81, 0],
      skyColor: "#000000",
      nodes: [
        { id: "a", kind: "box", size: [1, 1, 1], snapTo: { target: "b", face: "top" } },
        { id: "b", kind: "box", size: [1, 1, 1], snapTo: { target: "a", face: "top" } },
      ],
    });
    const cycle = await harness.callTool("hyperstage_inspect_bounds", { sceneJson: cyclic });
    expect(cycle.isError).toBe(true);
    expect(JSON.parse(cycle.content[0]?.text ?? "{}").cycle).toEqual(["a", "b", "a"]);
  });

  it("never pollutes stdout: every line is a JSON-RPC 2.0 message", () => {
    expect(harness.rawLines.length).toBeGreaterThanOrEqual(9);
    for (const line of harness.rawLines) {
      const parsed = JSON.parse(line) as JsonRpcMessage;
      expect(parsed.jsonrpc).toBe("2.0");
    }
    expect(harness.stderr.join("")).toContain("[hyperstage-mcp]");
  });
});
