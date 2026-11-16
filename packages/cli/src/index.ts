#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { PRESETS, getPreset, parseSceneJson } from "@hyperstage/core";
import { autoFixScene, lintScene, simulateScene } from "@hyperstage/spatial-linter";
import type { LintReport, SpatialDiagnostic } from "@hyperstage/spatial-linter";
import { exportSceneHtml } from "@hyperstage/mcp-server/html-exporter";
import { loadThreeSources } from "@hyperstage/mcp-server/three-sources";

export const VERSION = "1.0.0";
export const AGENT_TARGETS = ["hark", "openhands", "claude", "cursor"] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const err = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

function readScene(file: string) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Scene file not found: ${path}`);
  return parseSceneJson(readFileSync(path, "utf8"));
}

function parseIntOption(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3600) throw new InvalidArgumentError("must be an integer between 1 and 3600");
  return n;
}

function formatDiagnostic(d: SpatialDiagnostic): string {
  const related = d.relatedNodeId ? ` (vs ${d.relatedNodeId})` : "";
  const fix = d.suggestedFix ? `\n      fix: ${d.suggestedFix.rationale}` : "";
  return `  ${d.severity === "error" ? "✖" : "▲"} ${d.code} ${d.nodeId}${related}\n      ${d.message}${fix}`;
}

function printReport(name: string, report: LintReport): void {
  out(`${report.valid ? "✔" : "✖"} ${name}: ${report.diagnostics.length} diagnostic(s) in ${report.elapsedMs.toFixed(2)} ms`);
  const p = report.telemetry.passMs;
  out(
    `  passes: resolve ${p.resolve.toFixed(2)} | E01 ${p.overlap.toFixed(2)} | E02 ${p.physics.toFixed(2)} | E03 ${p.camera.toFixed(2)} | E04 ${p.navmesh.toFixed(2)} ms`,
  );
  for (const d of report.diagnostics) out(formatDiagnostic(d));
  if (report.navPath.length > 0) out(`  navPath: ${report.navPath.length} waypoints`);
}

/** Locates packages/skills relative to this file (works from src/ and dist/). */
export function skillsSourceDir(): string {
  const override = process.env.HYPERSTAGE_SKILLS_DIR;
  if (override !== undefined && override !== "") return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
}

interface SkillFile {
  name: string;
  description: string;
  content: string;
}

function readSkills(dir: string): SkillFile[] {
  if (!existsSync(dir)) throw new Error(`Skills directory not found: ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => {
      const content = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
      const match = /^---\n([\s\S]*?)\n---/.exec(content);
      const front = match?.[1] ?? "";
      const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? entry.name;
      const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
      if (name !== entry.name) throw new Error(`SKILL.md name "${name}" must match its folder "${entry.name}"`);
      if (description === "") throw new Error(`SKILL.md for ${entry.name} is missing a description`);
      return { name, description, content };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Installs every SKILL.md into agent-specific locations under `target`. Returns written paths. */
export function installSkills(target: string, agents: readonly AgentTarget[], sourceDir = skillsSourceDir()): string[] {
  const skills = readSkills(sourceDir);
  const written: string[] = [];
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(path);
  };
  for (const skill of skills) {
    for (const agent of agents) {
      if (agent === "cursor") {
        const body = skill.content.replace(/^---\n[\s\S]*?\n---\n?/, "");
        const description = skill.description.replace(/"/g, '\\"');
        write(
          join(target, ".cursor", "rules", `${skill.name}.mdc`),
          `---\ndescription: "${description}"\nglobs: "**/*.scene.json,**/*.scene.tsx"\nalwaysApply: false\n---\n${body}`,
        );
      } else {
        write(join(target, `.${agent}`, "skills", skill.name, "SKILL.md"), skill.content);
      }
    }
  }
  return written;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("hyperstage")
    .description("Deterministic 3D scene, physics, and playable-world compiler for AI coding agents")
    .version(VERSION);

  program
    .command("init")
    .description("Write a starter scene from one of the 5 built-in presets")
    .argument("[file]", "output scene file", "hyperstage.scene.json")
    .option("-p, --preset <preset>", `preset index (1-${PRESETS.length}) or id`, "1")
    .option("-f, --force", "overwrite an existing file", false)
    .action((file: string, opts: { preset: string; force: boolean }) => {
      const preset = getPreset(opts.preset);
      if (preset === undefined) throw new Error(`Unknown preset "${opts.preset}". Available: ${PRESETS.map((p) => `${p.index}:${p.id}`).join(", ")}`);
      const path = resolve(file);
      if (existsSync(path) && !opts.force) throw new Error(`${path} already exists (use --force to overwrite)`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(preset.scene, null, 2)}\n`);
      out(`✔ wrote ${path} (preset ${preset.index}: ${preset.title})`);
    });

  program
    .command("lint")
    .description("Run the 4-pass spatial linter (E01-E04)")
    .argument("<file>", "scene JSON file")
    .option("--json", "print the full LintReport as JSON (frames omitted unless --frames)", false)
    .option("--frames", "include the 180 physics frames in --json output", false)
    .option("--fix [out]", "apply the auto-fixer (up to 5 passes) and write the repaired scene (default: in place)")
    .action(async (file: string, opts: { json: boolean; frames: boolean; fix?: string | boolean }) => {
      const scene = readScene(file);
      if (opts.fix !== undefined && opts.fix !== false) {
        const result = await autoFixScene(scene);
        const target = typeof opts.fix === "string" ? resolve(opts.fix) : resolve(file);
        writeFileSync(target, `${JSON.stringify(result.scene, null, 2)}\n`);
        if (opts.json) {
          out(JSON.stringify({ passes: result.passes, applied: result.applied, report: { ...result.report, frames: opts.frames ? result.report.frames : undefined } }));
        } else {
          out(`auto-fix: ${result.applied.length} patch(es) over ${result.passes} pass(es) -> ${target}`);
          for (const a of result.applied) out(`  [pass ${a.pass}] ${a.code} ${a.nodeId}: ${a.rationale}`);
          printReport(scene.name, result.report);
        }
        process.exitCode = result.report.valid ? 0 : 1;
        return;
      }
      const report = await lintScene(scene);
      if (opts.json) out(JSON.stringify({ ...report, frames: opts.frames ? report.frames : undefined }));
      else printReport(scene.name, report);
      process.exitCode = report.valid ? 0 : 1;
    });

  program
    .command("sim")
    .description("Run the deterministic Rapier3D rollout")
    .argument("<file>", "scene JSON file")
    .option("-t, --ticks <ticks>", "ticks at 60 Hz", parseIntOption, 180)
    .option("--json", "print JSON", false)
    .action(async (file: string, opts: { ticks: number; json: boolean }) => {
      const scene = readScene(file);
      const sim = await simulateScene(scene, opts.ticks);
      if (opts.json) {
        out(JSON.stringify({ ticks: sim.ticks, elapsedMs: sim.elapsedMs, finalTransforms: sim.finalTransforms, peakSpeeds: sim.peakSpeeds }));
        return;
      }
      out(`✔ ${scene.name}: ${sim.ticks} ticks (${(sim.ticks / 60).toFixed(2)} s) in ${sim.elapsedMs.toFixed(2)} ms`);
      for (const [id, tr] of Object.entries(sim.finalTransforms)) {
        out(`  ${id.padEnd(20)} pos [${tr.position.map((v) => v.toFixed(3)).join(", ")}]  peak ${(sim.peakSpeeds[id] ?? 0).toFixed(2)} m/s`);
      }
    });

  program
    .command("export")
    .description("Export a self-contained HTML player (three.js + baked physics + WASD walk mode)")
    .argument("<file>", "scene JSON file")
    .option("-o, --out <out>", "output .html file")
    .option("--title <title>", "document title")
    .action(async (file: string, opts: { out?: string; title?: string }) => {
      const scene = readScene(file);
      const report = await lintScene(scene);
      const html = exportSceneHtml({ scene, frames: report.frames, navPath: report.navPath, title: opts.title ?? scene.name, three: loadThreeSources() });
      const target = resolve(opts.out ?? file.replace(/(\.scene)?\.json$/i, "") + ".html");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html);
      out(`✔ exported ${target} (${(html.length / 1024).toFixed(0)} KiB, ${report.frames.length} frames${report.valid ? "" : `, ${report.diagnostics.length} lint diagnostic(s)`})`);
    });

  const skills = program.command("skills").description("Agent skill packs");
  skills
    .command("install")
    .description("Install HyperStage SKILL.md packs for Hark, OpenHands, Claude Code and Cursor")
    .option("--target <dir>", "project root to install into", ".")
    .option("--agents <list>", `comma-separated subset of ${AGENT_TARGETS.join(",")}`, AGENT_TARGETS.join(","))
    .action((opts: { target: string; agents: string }) => {
      const agents = opts.agents.split(",").map((a) => a.trim()).filter((a) => a !== "");
      const invalid = agents.filter((a) => !(AGENT_TARGETS as readonly string[]).includes(a));
      if (invalid.length > 0) throw new Error(`Unknown agent target(s): ${invalid.join(", ")}`);
      const written = installSkills(resolve(opts.target), agents as AgentTarget[]);
      out(`✔ installed ${written.length} skill file(s):`);
      for (const path of written) out(`  ${path}`);
    });

  return program;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isEntryPoint();

/** Parses argv and runs the CLI; domain errors exit with code 2. */
export function runCli(argv: string[]): Promise<void> {
  return buildProgram()
    .parseAsync(argv)
    .then(() => undefined)
    .catch((error: unknown) => {
      err(`✖ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
}

if (invokedDirectly) void runCli(process.argv);
