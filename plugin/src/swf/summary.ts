// Words for the panel after a SWF load: what was added, and what was left out, without SWF vocabulary.
export type Imported = { name: string; frames: number; shapes: number; texts: number; components?: number; fonts: string[]; warnings: string[] };
export type ImportSummary = { title: string; layers: number; components: number; skipped: string[]; skippedCount: number; fonts: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
// one rule per kind of reader warning (see parse.ts); the first matching rule wins, repeats of a kind become one counted line
const RULES: [RegExp, (n: number) => string][] = [
  [/^character \d+ is not drawable/, (n) => `${plural(n, "element", "elements")} could not be drawn`],
  [/comes from another SWF/, (n) => `${plural(n, "element comes", "elements come")} from other SWF files and ${n === 1 ? "is" : "are"} left as empty frames`],
  [/imported font/, (n) => `Text in ${plural(n, "font", "fonts")} from other SWF files could not be read`],
  [/filters|blend modes/, () => "Some effects (bevel, colour filters, some blend modes) were left out"],
  [/unknown fill style/, (n) => `${plural(n, "shape has", "shapes have")} a fill Inkwell cannot read`],
  [/^bitmap \d+ is missing/, (n) => `${plural(n, "picture is", "pictures are")} missing from the file`],
  [/^bitmap \d+:/, (n) => `${plural(n, "picture", "pictures")} could not be read`],
  [/morph/, () => "Animated morph shapes were skipped"],
  [/^tag \d+:/, (n) => `${plural(n, "part", "parts")} of the file could not be read`],
];

export function summarize(m: Imported): ImportSummary {
  const groups = new Map<number, number>();
  const other: string[] = [];
  for (const w of m.warnings) {
    const i = RULES.findIndex(([re]) => re.test(w));
    if (i < 0) other.push(w);
    else groups.set(i, (groups.get(i) ?? 0) + 1);
  }
  const skipped = [...groups].sort((a, b) => a[0] - b[0]).map(([i, n]) => RULES[i][1](n)).concat(other);
  return {
    title: `Added “${m.name}”`,
    layers: m.frames + m.shapes + m.texts,
    components: m.components ?? 0,
    skipped,
    skippedCount: m.warnings.length,
    fonts: m.fonts.length ? `Inter used instead of ${m.fonts.join(", ")}` : "",
  };
}
