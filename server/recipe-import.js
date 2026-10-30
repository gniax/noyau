const HOSTS = new Set(["www.750g.com", "www.cuisineaz.com", "www.marmiton.org"]);
function targetUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error("Lien de recette invalide."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !HOSTS.has(url.hostname) || url.href.length > 2000) throw new Error("Lien HTTPS 750g, CuisineAZ ou Marmiton requis.");
  url.hash = ""; return url;
}
export function robotsAllows(text, pathname, userAgent = "NoyauRecipeImporter") {
  const agent = userAgent.toLowerCase();
  const groups = []; let group = null; let hadRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim(); if (!line) continue;
    const at = line.indexOf(":"); if (at < 0) continue;
    const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
    if (key === "user-agent") { if (!group || hadRules) { group = { agents: [], rules: [] }; groups.push(group); hadRules = false; } group.agents.push(value.toLowerCase()); }
    else if (group && (key === "allow" || key === "disallow")) { hadRules = true; if (value) group.rules.push({ allow: key === "allow", pattern: value }); }
  }
  const matches = groups.filter((g) => g.agents.some((a) => a === "*" || a !== "" && agent.includes(a)));
  const specific = matches.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const rules = (specific.length ? specific : matches).flatMap((g) => g.rules).filter((r) => { const exactEnd = r.pattern.endsWith("$"); const rule = exactEnd ? r.pattern.slice(0, -1) : r.pattern; const pattern = rule.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"); return new RegExp(`^${pattern}${exactEnd ? "$" : ""}`).test(pathname); }).sort((a, b) => b.pattern.replace(/\*/g, "").length - a.pattern.replace(/\*/g, "").length || Number(b.allow) - Number(a.allow));
  return rules[0]?.allow ?? true;
}
async function readBounded(response, limit) {
  if (!response.ok || !response.body) throw new Error("Page inaccessible ou protégée ; recopiez la recette manuellement.");
  const chunks = []; let size = 0; const reader = response.body.getReader();
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("Page trop volumineuse."); chunks.push(Buffer.from(value)); } } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}
const plain = (value, max) => typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
function minutesOf(value) { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(String(value || "")); return m ? Math.min(1440, Math.max(1, Number(m[1] || 0) * 60 + Number(m[2] || 0))) : 30; }
export function extractRecipe(html, sourceUrl) {
  const found = []; let nodes = 0;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 20 || ++nodes > 10000) return;
    if (Array.isArray(node)) return node.forEach((value) => visit(value, depth + 1));
    if ([node["@type"]].flat().includes("Recipe")) found.push(node);
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value, depth + 1);
  };
  for (const match of html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script\s*>/gi)) { try { visit(JSON.parse(match[1])); } catch { /* unrelated metadata */ } }
  const recipe = found.find((item) => item.name && Array.isArray(item.recipeIngredient)); if (!recipe) throw new Error("Aucune recette structurée trouvée ; recopiez les ingrédients manuellement.");
  const steps = []; const walkSteps = (value, depth = 0) => { if (depth > 8 || steps.length >= 30) return; if (typeof value === "string") { const text = plain(value, 500); if (text) steps.push(text); } else if (Array.isArray(value)) value.forEach((item) => walkSteps(item, depth + 1)); else if (value && typeof value === "object") { if (value.text) walkSteps(value.text, depth + 1); else walkSteps(value.itemListElement, depth + 1); } };
  walkSteps(recipe.recipeInstructions);
  const yieldValue = Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield; const servings = Number.parseInt(String(yieldValue || ""), 10);
  return { title: plain(recipe.name, 120), subtitle: plain(recipe.description, 180), minutes: minutesOf(recipe.totalTime || recipe.prepTime), servings: servings >= 1 && servings <= 12 ? servings : 2, rawIngredients: recipe.recipeIngredient.filter((value) => typeof value === "string").slice(0, 30).map((value) => plain(value, 250)).filter(Boolean), steps, sourceUrl };
}
export async function importRecipe(value, { fetchImpl = fetch } = {}) {
  let target = targetUrl(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const headers = { "user-agent": "NoyauRecipeImporter/1.0", accept: "text/html,application/json" };
    const robots = await fetchImpl(new URL("/robots.txt", target), { redirect: "manual", signal: AbortSignal.timeout(10000), headers });
    if (!robots.ok) throw new Error("Règles du site indisponibles ; import non effectué.");
    if (!robotsAllows(await readBounded(robots, 256 * 1024), target.pathname + target.search)) throw new Error("Import interdit par les règles du site.");
    const response = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(10000), headers });
    if ([301, 302, 303, 307, 308].includes(response.status)) { if (redirect === 3) throw new Error("Trop de redirections."); target = targetUrl(new URL(response.headers.get("location"), target).href); continue; }
    return extractRecipe(await readBounded(response, 2 * 1024 * 1024), target.href);
  }
  throw new Error("Import impossible.");
}
