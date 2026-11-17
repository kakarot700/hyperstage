#!/usr/bin/env node
/**
 * HyperStage MCP server (stdio). stdout is owned by the JSON-RPC transport:
 * this module never writes to it; all logging goes through console.error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getRapier } from "@hyperstage/spatial-linter";
import { loadThreeSources } from "./three-sources.js";
import { compileAndLint, exportHtml, inspectBounds, simulatePhysics, testPlayability } from "./tools.js";

const log = (...args: unknown[]): void => {
  console.error("[hyperstage-mcp]", ...args);
};

function ok(result: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function fail(error: unknown): CallToolResult {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const payload: Record<string, unknown> = { error: name, message };
  if (error instanceof Error && "issues" in error) payload.issues = (error as Error & { issues: unknown }).issues;
  if (error instanceof Error && "cycle" in error) payload.cycle = (error as Error & { cycle: unknown }).cycle;
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

async function guard(run: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    log("tool error:", error instanceof Error ? error.message : String(error));
    return fail(error);
  }
}

const sceneJson = z.string().min(2).describe("SceneAST serialized as JSON ({ name, gravity, skyColor, nodes })");

export function createServer(): McpServer {
  const server = new McpServer({ name: "hyperstage", version: "1.1.0" });

  server.registerTool(
    "hyperstage_compile_and_lint",
    {
      title: "Compile & lint a HyperStage scene",
      description:
        "Validates the SceneAST, resolves snapTo anchors, and runs the 4 deterministic spatial passes (E01 interpenetration, E02 180-tick Rapier stability, E03 camera occlusion, E04 goal reachability). Returns a summary, diagnostics with suggested fixes, and the nav path.",
      inputSchema: { sceneJson },
    },
    async (args) => guard(() => compileAndLint(args.sceneJson)),
  );

  server.registerTool(
    "hyperstage_inspect_bounds",
    {
      title: "Inspect resolved bounds",
      description: "Returns resolved world AABBs for every geometry node and pairwise surface clearances (negative = penetration).",
      inputSchema: { sceneJson },
    },
    async (args) => guard(() => inspectBounds(args.sceneJson)),
  );

  server.registerTool(
    "hyperstage_simulate_physics",
    {
      title: "Simulate physics",
      description: "Steps a deterministic Rapier3D world at dt = 1/60 for the requested ticks and returns final transforms and peak velocities.",
      inputSchema: { sceneJson, ticks: z.number().int().min(1).max(3600).describe("Number of 1/60 s ticks to simulate") },
    },
    async (args) => guard(() => simulatePhysics(args.sceneJson, args.ticks)),
  );

  server.registerTool(
    "hyperstage_test_playability",
    {
      title: "Test playability",
      description: "Runs voxel (0.25 m) navigation A* from spawn to goal with 0.5 m step-ups and 2.0 m gap jumps.",
      inputSchema: { sceneJson },
    },
    async (args) => guard(() => testPlayability(args.sceneJson)),
  );

  server.registerTool(
    "hyperstage_export_html",
    {
      title: "Export standalone HTML",
      description:
        "Compiles the scene into one self-contained .html file embedding three.js, OrbitControls, the pre-baked 180-frame Rapier playback and a WASD walk mode.",
      inputSchema: { sceneJson, title: z.string().min(1).max(200).optional() },
    },
    async (args) => guard(() => exportHtml(args.sceneJson, loadThreeSources(), args.title)),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready on stdio (5 tools)");
  // Warm the deterministic Rapier WASM in the background so the first lint is fast.
  getRapier().catch((error: unknown) => log("rapier init failed:", error instanceof Error ? error.message : String(error)));
}

main().catch((error: unknown) => {
  log("fatal:", error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
