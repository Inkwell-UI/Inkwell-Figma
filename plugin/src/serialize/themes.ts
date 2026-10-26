import type { Theme } from "@inkwell-ui/spec";

// Figma local variables -> `Swf.themes` (SPEC-CHANGES V6). The structural types below are the part of figma.variables the plugin reads;
// tests pass plain objects, the main thread passes the real API (see variablesApi in code.ts).
export interface FigCollection { id: string; name: string; modes: readonly { modeId: string; name: string }[]; defaultModeId: string; variableIds: readonly string[] }
export interface FigVariable { id: string; name: string; resolvedType: string; variableCollectionId: string; valuesByMode: Readonly<Record<string, unknown>> }
export interface VariablesApi { collections(): Promise<readonly FigCollection[]>; variable(id: string): Promise<FigVariable | null> }

type Kind = "color" | "number" | "boolean" | "string";
const KIND: Record<string, Kind> = { COLOR: "color", FLOAT: "number", BOOLEAN: "boolean", STRING: "string" };
const isAlias = (v: unknown): v is { type: "VARIABLE_ALIAS"; id: string } => !!v && typeof v === "object" && (v as { type?: unknown }).type === "VARIABLE_ALIAS" && typeof (v as { id?: unknown }).id === "string";
const isColor = (v: unknown): v is { r: number; g: number; b: number; a?: number } => !!v && typeof v === "object" && typeof (v as { r?: unknown }).r === "number";

/** One value of a variable in one mode; an alias is followed (same mode id if the target has it, else the target collection's default mode). Undefined = cannot be resolved. */
async function valueIn(api: VariablesApi, cols: ReadonlyMap<string, FigCollection>, v: FigVariable, modeId: string, depth = 0): Promise<unknown> {
  const raw = v.valuesByMode[modeId] ?? v.valuesByMode[cols.get(v.variableCollectionId)?.defaultModeId ?? ""];
  if (!isAlias(raw)) return raw;
  if (depth > 8) return undefined;
  const target = await api.variable(raw.id);
  return target ? valueIn(api, cols, target, modeId in target.valuesByMode ? modeId : cols.get(target.variableCollectionId)?.defaultModeId ?? modeId, depth + 1) : undefined;
}

const clean = (c: { r: number; g: number; b: number; a?: number }) => ({ r: c.r, g: c.g, b: c.b, ...(c.a !== undefined && c.a !== 1 && { a: c.a }) });

/** Every local collection as a `Theme`; variables of another type, with no resolvable value, or in a collection with no mode are left out. */
export async function collectThemes(api: VariablesApi): Promise<Theme[]> {
  const cols = await api.collections();
  const byId = new Map(cols.map((c) => [c.id, c]));
  const out: Theme[] = [];
  for (const c of cols) {
    if (!c.modes.length) continue;
    const variables: NonNullable<Theme["variables"]> = {};
    for (const id of c.variableIds) {
      const v = await api.variable(id);
      const type = v && KIND[v.resolvedType];
      if (!v || !type) continue;
      const values: Record<string, unknown> = {};
      for (const m of c.modes) {
        const x = await valueIn(api, byId, v, m.modeId);
        if (type === "color" ? isColor(x) : typeof x === (type === "number" ? "number" : type)) values[m.name] = type === "color" ? clean(x as { r: number; g: number; b: number }) : x;
      }
      if (Object.keys(values).length) variables[id] = { name: v.name, type, values };
    }
    out.push({ name: c.name, modes: c.modes.map((m) => m.name), variables });
  }
  return out;
}
