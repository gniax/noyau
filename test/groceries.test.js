import test from "node:test";
import assert from "node:assert/strict";
import { RECIPES, INGREDIENTS, RECIPE_FAMILIES } from "../shared/recipes.js";
import { recipeMatches } from "../shared/recipe-discovery.js";
import fs from "node:fs";
import { applyGroceryOperation as apply, compareBaskets, compatible, frequentProducts, initialGroceries, priceLine, shoppingList, suggestions } from "../shared/groceries.js";
import { menuCalendar, parisInstant } from "../shared/grocery-calendar.js";

const now = "2026-10-27T12:00:00Z";
function configured() { const state = initialGroceries(); state.settings.householdConfirmed = true; state.stores = state.stores.map((store) => ({ ...store, minimumCents: 0, feesCents: 0, minimumConfirmed: true, storeConfirmed: true })); return state; }
function offer(ingredientId, storeId, priceCents, extra = {}) { return { id: `${ingredientId}-${storeId}-${priceCents}`, ingredientId, storeId, priceCents, packQuantity: 1000, observedAt: now, sourceUrl: `https://${storeId === "carrefour" ? "www.carrefour.fr" : storeId === "leclerc" ? "www.leclercdrive.fr" : "picnic.app"}/produit`, ...extra }; }

test("catalog has 256 distinct costed recipes and explicitly disclosed family illustrations", () => {
  assert.equal(RECIPES.length, 256); assert.equal(new Set(RECIPES.map((recipe) => recipe.id)).size, 256); assert.equal(new Set(RECIPES.map((recipe) => recipe.title)).size, 256);
  assert.equal(new Set(RECIPES.map((recipe) => recipe.ingredients.map((item) => `${item.ingredientId}:${item.quantity}`).sort().join(" "))).size, 256);
  assert.equal(new Set(RECIPES.map((recipe) => `${recipe.image.atlas}:${recipe.image.cell}`)).size, 60);
  assert.equal(RECIPE_FAMILIES.length, 28);
  for (const family of RECIPE_FAMILIES) assert.equal(RECIPES.filter((recipe) => recipe.familyId === family.id).length, 8);
  for (const recipe of RECIPES) {
    assert.ok(recipe.ingredients.every((item) => INGREDIENTS[item.ingredientId] && Number.isFinite(item.quantity) && item.quantity > 0)); assert.ok(recipe.steps.length >= 3); assert.ok(recipe.estimateCents > 0);
    assert.equal(new Set(recipe.ingredients.map((item) => item.ingredientId)).size, recipe.ingredients.length);
    assert.ok(fs.existsSync(new URL(`../public/courses/recipes-atlas-${recipe.image.atlas}.png`, import.meta.url)));
    if (recipe.familyId !== "essentials") assert.match(recipe.imageDisclosure, /partagée/);
  }
  assert.deepEqual(RECIPES.slice(0, 32).map((recipe) => recipe.id), Array.from({ length: 32 }, (_, index) => `recipe-${String(index + 1).padStart(2, "0")}`));
});
test("discovery searches all recipes, ingredients and families without accent sensitivity", () => {
  const peanuts = RECIPES.filter((recipe) => recipeMatches(recipe, { search: "cacahuetes" })); assert.ok(peanuts.length >= 3); assert.ok(peanuts.every((recipe) => recipe.ingredients.some((item) => item.ingredientId === "peanut")));
  assert.equal(RECIPES.filter((recipe) => recipeMatches(recipe, { family: "tagine" })).length, 8);
  assert.equal(RECIPES.filter((recipe) => recipeMatches(recipe, { search: "Risotto forestier" })).length, 1);
  assert.ok(RECIPES.filter((recipe) => recipeMatches(recipe, { search: "oeufs" })).length >= 10);
  assert.ok(RECIPES.filter((recipe) => recipeMatches(recipe, { filter: "vegan" })).length >= 30);
  assert.equal(recipeMatches(RECIPES[0], { family: "pizza" }), false);
  assert.equal(recipeMatches(RECIPES[0], { filter: "favorites", preferences: { [RECIPES[0].id]: "favorite" } }), true);
});
test("new ingredients propagate shellfish, dairy, nut and sesame exclusions", () => {
  const state = configured(); state.settings.allergens = ["crustacés", "arachides", "sésame", "fruits à coque", "lait"];
  for (const recipe of suggestions(state)) assert.ok(!recipe.allergens.some((allergen) => state.settings.allergens.includes(allergen)));
  for (const recipe of RECIPES.filter((item) => item.ingredients.some(({ ingredientId }) => ingredientId === "shrimp"))) { assert.equal(recipe.vegetarian, false); assert.ok(recipe.allergens.includes("crustacés")); }
});
test("menus are proposed, require dietary confirmation and only accepted meals create shopping needs", () => {
  let state = apply(initialGroceries(), { type: "plan", payload: { start: "2026-10-27" } }); assert.equal(state.plan.length, 7); assert.equal(shoppingList(state).length, 0);
  assert.throws(() => apply(state, { type: "slot", payload: { id: state.plan[0].id, status: "accepted" } }), /Confirmez le foyer/);
  state = apply(state, { type: "settings", payload: { householdConfirmed: true } }); state = apply(state, { type: "slot", payload: { id: state.plan[0].id, status: "accepted" } }); assert.ok(shoppingList(state).length > 0);
  state = apply(state, { type: "settings", payload: { days: 14 } }); state = apply(state, { type: "plan", payload: { start: "2026-10-27" } }); assert.equal(state.plan.length, 14); assert.equal(state.plan.at(-1).date, "2026-11-09");
  assert.equal(new Set(state.plan.map((slot) => slot.recipeId)).size, 14);
  assert.equal(new Set(state.plan.map((slot) => RECIPES.find((recipe) => recipe.id === slot.recipeId).familyId)).size, 14);
});
test("allergy, diet, excluded ingredients and rejected recipes constrain suggestions", () => {
  const state = configured(); state.settings.diet = "vegan"; state.settings.allergens = ["soja"]; state.settings.excludedIngredients = ["chickpea"];
  const selected = suggestions(state, "2026-10-27"); assert.ok(selected.length > 0);
  for (const recipe of selected) { assert.equal(recipe.vegan, true); assert.equal(recipe.allergens.includes("soja"), false); assert.equal(recipe.ingredients.some((item) => item.ingredientId === "chickpea"), false); }
  state.preferences[selected[0].id] = "disliked"; assert.equal(suggestions(state).some((recipe) => recipe.id === selected[0].id), false);
  assert.equal(compatible(RECIPES.find((recipe) => recipe.allergens.includes("à vérifier sur l'étiquette")), state.settings), false);
});
test("pantry full exclusions and partial stock recalculate purchasing needs without deleting recipes", () => {
  let state = configured(); state = apply(state, { type: "extra", payload: { ingredientId: "rice", quantity: 750 } });
  state = apply(state, { type: "pantry", payload: { ingredientId: "rice", quantity: 250 } }); assert.equal(shoppingList(state)[0].needed, 500);
  state = apply(state, { type: "pantry", payload: { ingredientId: "rice", skip: true } }); assert.equal(shoppingList(state)[0].needed, 0); assert.equal(compareBaskets(state, now).empty, true);
});
test("packaging, immediate discounts and deferred loyalty are accounted separately", () => {
  const line = priceLine({ ingredientId: "rice", label: "Riz", needed: 1100, unit: "g" }, offer("rice", "carrefour", 300, { packQuantity: 500, instantDiscountCents: 50, loyaltyCents: 80 }), { id: "carrefour", loyalty: true });
  assert.equal(line.packs, 3); assert.equal(line.checkoutCents, 750); assert.equal(line.loyaltyCents, 240); assert.equal(line.effectiveCents, 510); assert.equal(line.surplus, 400);
  assert.equal(priceLine({ needed: 1100 }, offer("rice", "carrefour", 300, { packQuantity: 500, loyaltyCents: 80 }), { id: "carrefour", loyalty: false }).loyaltyCents, 0);
});
test("bundle pricing is not silently multiplied per unit", () => { const line = priceLine({ needed: 4 }, offer("rice", "carrefour", 300, { packQuantity: 1, bundleQuantity: 3, bundlePriceCents: 600 }), { id: "carrefour", loyalty: false }); assert.equal(line.checkoutCents, 900); });
test("comparator never invents missing, expired, future or ineligible-card prices", () => {
  const state = configured(); state.extras = [{ ingredientId: "rice", quantity: 500 }];
  for (const extra of [{ validUntil: "2026-10-26T12:00:00Z" }, { observedAt: "2026-10-28T12:00:00Z" }, { observedAt: "2026-10-20T12:00:00Z" }, { loyaltyRequired: true }]) {
    state.offers = [offer("rice", "carrefour", 100, extra)]; assert.deepEqual(compareBaskets(state, now).missing, ["rice"]);
  }
});
test("at most two shops; three individually cheapest stores cannot form an illegal basket", () => {
  const state = configured(); state.extras = ["rice", "pasta", "milk"].map((ingredientId) => ({ ingredientId, quantity: 1000 }));
  state.offers = [offer("rice", "carrefour", 100), offer("pasta", "leclerc", 100), offer("milk", "picnic", 100)]; assert.equal(compareBaskets(state, now).best, null);
  state.offers.push(offer("milk", "leclerc", 250)); const result = compareBaskets(state, now); assert.equal(result.best.carts.length, 2); assert.equal(result.best.checkoutCents, 450);
});
test("minimums and fees can make a slightly more expensive single drive the cheapest feasible choice", () => {
  const state = configured(); state.stores.find((store) => store.id === "carrefour").minimumCents = 500; state.stores.find((store) => store.id === "leclerc").feesCents = 100;
  state.extras = ["rice", "milk"].map((ingredientId) => ({ ingredientId, quantity: 1000 }));
  state.offers = [offer("rice", "carrefour", 100), offer("milk", "carrefour", 500), offer("rice", "leclerc", 200), offer("milk", "leclerc", 100)];
  const result = compareBaskets(state, now); assert.equal(result.best.checkoutCents, 400); assert.equal(result.best.carts[0].id, "leclerc");
});
test("unknown minimums, fees and address eligibility block checkout, even with complete prices", () => {
  const state = initialGroceries(); state.extras = [{ ingredientId: "rice", quantity: 1000 }]; state.offers = [offer("rice", "carrefour", 100)]; const result = compareBaskets(state, now);
  assert.equal(result.best, null); assert.ok(result.options[0].warnings.length >= 3);
});
test("a higher-priced product at the same store can be necessary to meet its minimum", () => {
  const state = configured(); state.stores.find((store) => store.id === "carrefour").minimumCents = 200; state.extras = [{ ingredientId: "rice", quantity: 1000 }];
  state.offers = [offer("rice", "carrefour", 100), offer("rice", "carrefour", 200)];
  assert.equal(compareBaskets(state, now).best.checkoutCents, 200);
  assert.equal(compareBaskets(state, now).best.carts[0].lines[0].packs, 1);
});
test("history suggestions only use imported frequent products and importing same ID does not duplicate", () => {
  let state = configured(); const order = { id: "test-order", date: "2026-10-20", storeId: "carrefour", lines: [{ ingredientId: "milk", quantity: 1000, priceCents: 120 }] };
  state = apply(state, { type: "order", payload: order }); state = apply(state, { type: "order", payload: order }); assert.equal(state.orders.length, 1); assert.equal(frequentProducts(state).length, 0);
  state = apply(state, { type: "order", payload: { ...order, id: "second-order", date: "2026-10-27" } }); assert.equal(frequentProducts(state)[0].id, "milk");
});
test("operation validation rejects forged fields, negative money and non-retailer URLs", () => {
  for (const payload of [{ people: 0 }, { budgetCents: -1 }, { token: "forbidden" }]) assert.throws(() => apply(configured(), { type: "settings", payload }));
  assert.throws(() => apply(configured(), { type: "offer", payload: offer("rice", "carrefour", -1) }));
  assert.throws(() => apply(configured(), { type: "offer", payload: offer("rice", "carrefour", 100, { sourceUrl: "https://carrefour.fr.attacker.invalid/product" }) }));
});
test("menu calendar preserves Paris time across daylight-saving transitions", () => {
  assert.equal(parisInstant("2026-07-01", "19:30").toISOString(), "2026-07-01T17:30:00.000Z"); assert.equal(parisInstant("2026-11-01", "19:30").toISOString(), "2026-11-01T18:30:00.000Z");
  assert.equal(parisInstant("2026-03-29", "02:30").toISOString(), "2026-03-29T01:30:00.000Z");
  const state = configured(); state.plan = [{ id: "2026-11-01-dinner", date: "2026-11-01", meal: "dinner", status: "accepted", recipeId: RECIPES[0].id, portions: 2 }];
  const calendar = menuCalendar(state, new Date(now)); assert.match(calendar, /DTSTART:20261101T183000Z/); assert.match(calendar, /TRIGGER:-PT60M/); assert.doesNotMatch(calendar, /VALUE=DATE/);
});

test("small exhaustive cases match the exact cheapest feasible assignment including shop minimums", () => {
  let seed = 17; const random = (max) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 25; trial++) {
    const state = configured(); state.extras = ["rice", "pasta", "milk", "egg"].map((ingredientId) => ({ ingredientId, quantity: 1 }));
    state.stores.forEach((store) => { store.minimumCents = random(8) * 100; store.feesCents = random(3) * 30; });
    state.offers = state.extras.flatMap(({ ingredientId }) => state.stores.flatMap((store) => [offer(ingredientId, store.id, 50 + random(5) * 100, { packQuantity: 1, id: `${trial}-${ingredientId}-${store.id}-a` }), offer(ingredientId, store.id, 75 + random(5) * 100, { packQuantity: 1, id: `${trial}-${ingredientId}-${store.id}-b` })]));
    let minimum = Infinity;
    const search = (index, spend) => {
      if (index === state.extras.length) { const used = Object.keys(spend); if (used.length > 2 || used.some((id) => spend[id] < state.stores.find((store) => store.id === id).minimumCents)) return; minimum = Math.min(minimum, used.reduce((sum, id) => sum + spend[id] + state.stores.find((store) => store.id === id).feesCents, 0)); return; }
      for (const item of state.offers.filter((item) => item.ingredientId === state.extras[index].ingredientId)) search(index + 1, { ...spend, [item.storeId]: (spend[item.storeId] || 0) + item.priceCents });
    };
    search(0, {}); const result = compareBaskets(state, now); assert.equal(result.optimal, true); assert.equal(result.best?.checkoutCents ?? Infinity, minimum);
  }
});
