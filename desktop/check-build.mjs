// `npm run build`: syntax-check every desktop source file (TypeScript is run directly by Node,
// so there is nothing to compile) and confirm the page loads every script it names.
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { readdirSync, readFileSync, existsSync } from "node:fs";
process.removeAllListeners("warning");
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(desktop).filter((name) => /\.(c?js|mjs|ts)$/.test(name));
let failed = 0;
for (const name of files) {
  try {
    if (name.endsWith(".ts")) {
      // Node runs these by erasing the types; check what it would run.
      const code = stripTypeScriptTypes(readFileSync(join(desktop, name), "utf8"));
      execFileSync(process.execPath, ["--input-type=module", "--check"], { input: code, stdio: "pipe", env: { ...process.env } });
    } else {
      execFileSync(process.execPath, ["--check", join(desktop, name)], { stdio: "pipe", env: { ...process.env } });
    }
  } catch (error) {
    failed++;
    console.error(`${name}: ${String(error.stderr || error.message).trim()}`);
  }
}
const page = readFileSync(join(desktop, "index.html"), "utf8");
for (const [, src] of page.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  if (!existsSync(join(desktop, src))) { failed++; console.error(`index.html names a missing file: ${src}`); }
}
const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) { failed++; console.error("Duplicate element ids: " + [...new Set(duplicates)].join(", ")); }
for (const script of ["renderer.js", "daily.js", "folders.js", "capture.js"]) {
  for (const [, id] of readFileSync(join(desktop, script), "utf8").matchAll(/(?:(?<![.\w])get|getElementById)\("([\w-]+)"\)/g)) {
    if (!ids.includes(id)) { failed++; console.error(`${script} looks up a missing element: #${id}`); }
  }
}
if (failed) process.exit(1);
console.log(`Checked ${files.length} source files and the page's scripts and elements.`);
