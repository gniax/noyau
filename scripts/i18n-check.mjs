// Liste les textes tr("...") sans traduction anglaise: node scripts/i18n-check.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "src/locales/en.json"), "utf8"));
const missing = new Set();
for (const file of fs.readdirSync(path.join(root, "src"))) {
  if (!/\.(jsx?|mjs)$/.test(file)) continue;
  const source = fs.readFileSync(path.join(root, "src", file), "utf8");
  for (const match of source.matchAll(/\btr\(("(?:[^"\\]|\\.)*")/g)) {
    const key = JSON.parse(match[1]);
    if (!(key in en)) missing.add(`${file}: ${key}`);
  }
}
for (const line of missing) console.log(line);
process.exitCode = missing.size ? 1 : 0;
