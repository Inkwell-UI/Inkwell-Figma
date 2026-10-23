import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const common = { bundle: true, target: "es2017", write: false, logLevel: "warning" };
mkdirSync("plugin/dist", { recursive: true });

const code = await build({ ...common, entryPoints: ["plugin/src/code.ts"], format: "iife" });
writeFileSync("plugin/dist/code.js", code.outputFiles[0].text);

const ui = await build({ ...common, entryPoints: ["plugin/src/ui.ts"], format: "iife" });
const js = ui.outputFiles[0].text.replaceAll("</script", "<\\/script");
// replacer function: the bundle may contain "$" sequences that String.replace would interpret
writeFileSync("plugin/dist/ui.html", readFileSync("plugin/src/ui.html", "utf8").replace("/*SCRIPT*/", () => js));
console.log("built plugin/dist/code.js and ui.html");
