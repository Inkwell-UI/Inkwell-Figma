import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("plugin/dist", { recursive: true });
copyFileSync("plugin/ui.src.html", "plugin/dist/ui.html");
