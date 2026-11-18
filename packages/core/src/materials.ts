import type { MaterialSpec } from "./schema.js";

/** Curated PBR presets that every renderer and exporter resolves identically. */
export const MATERIAL_PRESET_NAMES = [
  "brushed-metal",
  "anodized-dark",
  "frosted-glass",
  "matte-concrete",
  "warm-oak",
  "emissive-cyan",
  "emissive-amber",
  "ceramic-white",
] as const;

export type MaterialPresetName = (typeof MATERIAL_PRESET_NAMES)[number];

/** A node's `material`: a preset name or a custom PBR description (v1 `{ color, ... }` objects stay valid). */
export type MaterialInput = MaterialPresetName | MaterialSpec;

/** Fully-populated PBR material, ready for three.js, glTF or any other renderer. */
export interface ResolvedMaterial {
  /** Preset name, "custom" for an inline object, or "default" when the node has no material. */
  name: MaterialPresetName | "custom" | "default";
  /** sRGB hex colour, always #rrggbb. */
  color: string;
  metalness: number;
  roughness: number;
  opacity: number;
  /** sRGB hex emissive colour, always #rrggbb (#000000 when not emissive). */
  emissive: string;
  emissiveIntensity: number;
  /** True when opacity < 1 and the renderer must alpha-blend. */
  transparent: boolean;
}

type PresetValues = Omit<ResolvedMaterial, "name" | "transparent">;

export const MATERIAL_PRESETS: Readonly<Record<MaterialPresetName, Readonly<PresetValues>>> = {
  "brushed-metal": { color: "#b8bcc4", metalness: 1, roughness: 0.35, opacity: 1, emissive: "#000000", emissiveIntensity: 0 },
  "anodized-dark": { color: "#2b2e36", metalness: 0.85, roughness: 0.4, opacity: 1, emissive: "#000000", emissiveIntensity: 0 },
  "frosted-glass": { color: "#dfe8f0", metalness: 0, roughness: 0.15, opacity: 0.45, emissive: "#000000", emissiveIntensity: 0 },
  "matte-concrete": { color: "#8d8a84", metalness: 0, roughness: 0.95, opacity: 1, emissive: "#000000", emissiveIntensity: 0 },
  "warm-oak": { color: "#a0703f", metalness: 0, roughness: 0.65, opacity: 1, emissive: "#000000", emissiveIntensity: 0 },
  "emissive-cyan": { color: "#0e3b44", metalness: 0.1, roughness: 0.4, opacity: 1, emissive: "#22d3ee", emissiveIntensity: 2.5 },
  "emissive-amber": { color: "#4a2a06", metalness: 0.1, roughness: 0.4, opacity: 1, emissive: "#f59e0b", emissiveIntensity: 2.5 },
  "ceramic-white": { color: "#f2f0eb", metalness: 0, roughness: 0.25, opacity: 1, emissive: "#000000", emissiveIntensity: 0 },
};

/** Values used for nodes without a material (identical to the v1 renderer defaults). */
export const DEFAULT_MATERIAL: Readonly<ResolvedMaterial> = {
  name: "default",
  color: "#8a8f98",
  metalness: 0.1,
  roughness: 0.8,
  opacity: 1,
  emissive: "#000000",
  emissiveIntensity: 0,
  transparent: false,
};

export function isMaterialPresetName(value: string): value is MaterialPresetName {
  return (MATERIAL_PRESET_NAMES as readonly string[]).includes(value);
}

/** Expands #rgb to #rrggbb and lower-cases the result. */
export function normalizeHexColor(hex: string): string {
  const body = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = body.length === 3 ? body.split("").map((c) => c + c).join("") : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new TypeError(`invalid hex colour "${hex}"`);
  return `#${full.toLowerCase()}`;
}

/** sRGB hex colour to 0..1 sRGB channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const full = normalizeHexColor(hex);
  const value = Number.parseInt(full.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB hex colour to linear-light channels (what glTF factors expect). */
export function hexToLinearRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** Resolves a node's `material` (preset name, custom object, or nothing) to a complete PBR material. */
export function resolveMaterial(input: MaterialInput | undefined): ResolvedMaterial {
  if (input === undefined) return { ...DEFAULT_MATERIAL };
  if (typeof input === "string") {
    if (!isMaterialPresetName(input)) {
      throw new TypeError(`unknown material preset "${input}" (expected one of ${MATERIAL_PRESET_NAMES.join(", ")})`);
    }
    const preset = MATERIAL_PRESETS[input];
    return { name: input, ...preset, transparent: preset.opacity < 1 };
  }
  const opacity = input.opacity ?? DEFAULT_MATERIAL.opacity;
  const emissive = input.emissive === undefined ? DEFAULT_MATERIAL.emissive : normalizeHexColor(input.emissive);
  return {
    name: "custom",
    color: normalizeHexColor(input.color),
    metalness: input.metalness ?? DEFAULT_MATERIAL.metalness,
    roughness: input.roughness ?? DEFAULT_MATERIAL.roughness,
    opacity,
    emissive,
    emissiveIntensity: input.emissiveIntensity ?? (input.emissive === undefined ? 0 : 1),
    transparent: opacity < 1,
  };
}
