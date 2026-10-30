import test from "node:test";
import assert from "node:assert/strict";
import { importRecipe, robotsAllows, extractRecipe } from "../server/recipe-import.js";
const html = `<script type="application/ld+json">{"@graph":[{"@type":"Recipe","name":"Plat maison","recipeIngredient":["200 g de riz","3 tomates"],"totalTime":"PT1H5M","recipeYield":"3 portions","recipeInstructions":[{"@type":"HowToStep","text":"Cuire le riz"},{"@type":"HowToSection","itemListElement":[{"text":"Ajouter les tomates"}]}]}]}</script>`;
test("Recipe JSON-LD extraction preserves source and requires manual ingredient mapping", () => {
 const data = extractRecipe(html, "https://www.750g.com/plat.htm"); assert.equal(data.title, "Plat maison"); assert.equal(data.minutes, 65); assert.equal(data.servings, 3); assert.deepEqual(data.rawIngredients, ["200 g de riz", "3 tomates"]); assert.deepEqual(data.steps, ["Cuire le riz", "Ajouter les tomates"]); assert.equal(data.sourceUrl, "https://www.750g.com/plat.htm");
});
test("robots denies protected routes and honors longest allowed rule and end marker", () => {
 const robots = "User-agent: *\nDisallow: /private/*\nAllow: /private/public\nDisallow: /exact$\n"; assert.equal(robotsAllows(robots, "/private/a"), false); assert.equal(robotsAllows(robots, "/private/public/x"), true); assert.equal(robotsAllows(robots, "/exact"), false); assert.equal(robotsAllows(robots, "/exactly"), true);
});
test("import checks robots and rejects private addresses and unsafe redirects", async () => {
 let calls = 0; const fetchImpl = async (url) => { calls++; if (new URL(url).pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /interdit\n"); return new Response(html); };
 assert.equal((await importRecipe("https://www.750g.com/plat.htm", { fetchImpl })).title, "Plat maison"); assert.equal(calls, 2);
 await assert.rejects(importRecipe("https://www.750g.com/interdit", { fetchImpl }), /interdit/); await assert.rejects(importRecipe("https://127.0.0.1:4242/", { fetchImpl }), /requis/);
 await assert.rejects(importRecipe("https://www.750g.com/plat.htm", { fetchImpl: async (url) => new URL(url).pathname === "/robots.txt" ? new Response("User-agent: *\nAllow: /") : Response.redirect("https://127.0.0.1/", 302) }), /requis/);
});
