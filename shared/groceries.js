import { INGREDIENTS, RECIPES, RECIPE_BY_ID, enrichRecipe } from "./recipes.js";

export const RETAILERS = [
  { id: "carrefour", name: "Carrefour", color: "#2374c6", icon: "C", mode: "drive", url: "https://www.carrefour.fr/courses", locator: "https://www.carrefour.fr/magasin/type/drive/le-chesnay-rocquencourt-78158", leaflet: "https://www.carrefour.fr/catalogue", source: "https://www.carrefour.fr/courses", minimumCents: null, note: "Minimum et préparation à confirmer pour le magasin choisi ; conditions officielles variables." },
  { id: "leclerc", name: "E.Leclerc DRIVE", color: "#ef8a24", icon: "E", mode: "drive", url: "https://www.leclercdrive.fr/", locator: "https://www.leclercdrive.fr/region-ile-de-france/paris/", leaflet: "https://www.e.leclerc/e/catalogue", source: "https://www.leclercdrive.fr/region-ile-de-france/paris/", minimumCents: null, note: "Bois-d'Arcy figure dans la liste officielle autour de Paris ; tarifs du point de retrait requis." },
  { id: "picnic", name: "Picnic", color: "#eb575b", icon: "P", mode: "delivery", url: "https://picnic.app/fr/", locator: "https://picnic.app/fr/", leaflet: "https://picnic.app/fr/", source: "https://picnic.app/fr/faq", minimumCents: 5000, note: "Livraison, pas un drive ; éligibilité de l'adresse et minimum du créneau à confirmer dans l'application." },
];

export function initialGroceries() {
  return { version: 1, revision: 0, settings: { address: "", postalCode: "78150", city: "Le Chesnay-Rocquencourt", people: 2, diet: "all", allergens: [], excludedIngredients: [], householdConfirmed: false, days: 7, budgetCents: 8000, meal: "dinner", remindAt: "18:30", reminders: false, priceMaxAgeHours: 48 },
    preferences: {}, plan: [], pantry: {}, extras: [], offers: [], orders: [], customRecipes: [], stores: RETAILERS.map((retailer) => ({ id: retailer.id, enabled: true, storeName: "", storeConfirmed: false, minimumCents: retailer.minimumCents, feesCents: null, minimumConfirmed: false, loyalty: false })), updatedAt: null };
}

export function dateParis(date = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
export function addDays(date, days) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export const money = (cents) => Number.isFinite(cents) ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100) : "À relever";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const safeText = (value, limit = 200) => typeof value === "string" && value.length <= limit;
const validDate = (value) => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function recipeFor(state, id) { return RECIPE_BY_ID[id] || (state.customRecipes || []).find((recipe) => recipe.id === id) || null; }
export function allRecipes(state) { return [...RECIPES, ...(state.customRecipes || [])]; }
export function selectedIngredientIds(state) { return new Set(state.plan.filter((slot) => slot.status === "accepted").flatMap((slot) => recipeFor(state, slot.recipeId)?.ingredients.map((item) => item.ingredientId) || [])); }
export function sharedIngredientCount(recipe, ids) { return recipe.ingredients.filter((item) => ids.has(item.ingredientId)).length; }
export function compatible(recipe, settings) {
  if (!recipe) return false;
  return !(settings.diet === "vegetarian" && !recipe.vegetarian) && !(settings.diet === "vegan" && !recipe.vegan)
    && !(settings.allergens.length && recipe.allergens.includes("à vérifier sur l'étiquette"))
    && !recipe.allergens.some((item) => settings.allergens.includes(item))
    && !recipe.ingredients.some(({ ingredientId }) => settings.excludedIngredients.includes(ingredientId));
}

export function suggestions(state, date = dateParis()) {
  const seed = [...date].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const promoted = new Set(state.offers.filter((offer) => { const store = state.stores.find((item) => item.id === offer.storeId); return store?.enabled && (offer.instantDiscountCents > 0 || offer.bundleQuantity || store.loyalty && offer.loyaltyCents > 0) && offerUsable(offer, store, new Date().toISOString(), state.settings.priceMaxAgeHours); }).map((offer) => offer.ingredientId));
  const selected = selectedIngredientIds(state); const accepted = new Set(state.plan.filter((slot) => slot.status === "accepted").map((slot) => slot.recipeId));
  return allRecipes(state).filter((recipe) => compatible(recipe, state.settings) && state.preferences[recipe.id] !== "disliked")
    .map((recipe, index) => { const owned = recipe.ingredients.filter((item) => state.pantry[item.ingredientId]?.skip || state.pantry[item.ingredientId]?.quantity >= item.quantity).length / recipe.ingredients.length; const promotions = recipe.ingredients.filter((item) => promoted.has(item.ingredientId)).length / recipe.ingredients.length; return { recipe, shared: sharedIngredientCount(recipe, selected), accepted: accepted.has(recipe.id), score: (index * 19 + seed) % 53 + owned * 8 + promotions * 8 + (state.preferences[recipe.id] === "favorite" ? 12 : 0) }; })
    .sort((a, b) => selected.size ? Number(a.accepted) - Number(b.accepted) || b.shared - a.shared || b.score - a.score : b.score - a.score).map(({ recipe }) => recipe);
}

export function proposePlan(state, start = dateParis()) {
  const choices = suggestions(state, start);
  if (!choices.length) throw new Error("Aucune recette compatible : ajustez les filtres alimentaires.");
  const used = new Set(); const families = new Map();
  return Array.from({ length: state.settings.days }, (_, index) => {
    const remaining = choices.filter((recipe) => !used.has(recipe.id)); const pool = remaining.length ? remaining : choices;
    // Balance cooking families without weakening dietary exclusions or repeating a
    // recipe before the compatible catalogue is exhausted. Ranking breaks ties.
    const recipe = pool.reduce((best, candidate) => (families.get(candidate.familyId) || 0) < (families.get(best.familyId) || 0) ? candidate : best);
    used.add(recipe.id); families.set(recipe.familyId, (families.get(recipe.familyId) || 0) + 1);
    return { id: `${addDays(start, index)}-${state.settings.meal}`, date: addDays(start, index), meal: state.settings.meal, recipeId: recipe.id, portions: state.settings.people, status: "proposed" };
  });
}

export function shoppingList(state) {
  const lines = new Map();
  const add = (ingredientId, quantity, source) => {
    const item = lines.get(ingredientId) || { ingredientId, quantity: 0, recipeIds: [], ...INGREDIENTS[ingredientId] };
    item.quantity += quantity;
    if (source && !item.recipeIds.includes(source)) item.recipeIds.push(source);
    lines.set(ingredientId, item);
  };
  for (const slot of state.plan.filter((item) => item.status === "accepted")) {
    const recipe = recipeFor(state, slot.recipeId);
    if (!recipe || !compatible(recipe, state.settings)) continue;
    for (const ingredient of recipe.ingredients) add(ingredient.ingredientId, ingredient.quantity * slot.portions / recipe.servings, recipe.id);
  }
  for (const extra of state.extras) add(extra.ingredientId, extra.quantity, null);
  return [...lines.values()].map((line) => {
    const pantry = state.pantry[line.ingredientId] || {};
    const needed = pantry.skip ? 0 : Math.max(0, Math.round((line.quantity - (pantry.quantity || 0)) * 100) / 100);
    return { ...line, needed, owned: line.quantity - needed, skipped: Boolean(pantry.skip), estimateCents: Math.round(needed / line.referenceQuantity * line.referenceCents) };
  }).sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

function offerUsable(offer, store, now, maxAge) {
  const time = new Date(now).getTime();
  return offer.available !== false && (!offer.loyaltyRequired || store.loyalty) && (!offer.validFrom || Date.parse(offer.validFrom) <= time)
    && (!offer.validUntil || Date.parse(offer.validUntil) >= time) && time - Date.parse(offer.observedAt) <= maxAge * 3600000 && Date.parse(offer.observedAt) <= time + 300000;
}

export function priceLine(line, offer, store) {
  const packs = Math.ceil(line.needed / offer.packQuantity);
  const unit = Math.max(0, offer.priceCents - (offer.instantDiscountCents || 0));
  let checkoutCents = packs * unit;
  if (offer.bundleQuantity && offer.bundlePriceCents !== undefined) checkoutCents = Math.floor(packs / offer.bundleQuantity) * offer.bundlePriceCents + packs % offer.bundleQuantity * unit;
  const loyaltyCents = store.loyalty ? Math.min(checkoutCents, packs * (offer.loyaltyCents || 0)) : 0;
  return { ingredientId: line.ingredientId, label: line.label, quantity: line.needed, unit: line.unit, packs, surplus: packs * offer.packQuantity - line.needed, checkoutCents, loyaltyCents, effectiveCents: checkoutCents - loyaltyCents, offerId: offer.id, storeId: store.id, sourceUrl: offer.sourceUrl, observedAt: offer.observedAt };
}

// Exact until the explicit state cap. Never advertise global market optimality or fill missing prices.
export function compareBaskets(state, now = new Date().toISOString()) {
  const lines = shoppingList(state).filter((line) => line.needed > 0);
  if (!lines.length) return { best: null, options: [], missing: [], empty: true, optimal: true };
  const stores = state.stores.filter((store) => store.enabled);
  const priced = new Map();
  for (const line of lines) {
    const choices = stores.flatMap((store) => state.offers.filter((offer) => offer.storeId === store.id && offer.ingredientId === line.ingredientId && offerUsable(offer, store, now, state.settings.priceMaxAgeHours)).map((offer) => priceLine(line, offer, store)));
    // Different checkout/loyalty trade-offs are retained; only strictly dominated offers disappear.
    priced.set(line.ingredientId, choices.filter((choice, index) => !choices.some((other, otherIndex) => other.storeId === choice.storeId && (other.checkoutCents === choice.checkoutCents || stores.find((store) => store.id === choice.storeId).minimumCents === 0) && other.checkoutCents <= choice.checkoutCents && other.loyaltyCents >= choice.loyaltyCents && (other.checkoutCents < choice.checkoutCents || other.loyaltyCents > choice.loyaltyCents || otherIndex < index))));
  }
  const missing = lines.filter((line) => !priced.get(line.ingredientId).length).map((line) => line.ingredientId);
  if (missing.length) return { best: null, options: [], missing, empty: false, optimal: false };
  const sets = stores.flatMap((store, index) => [[store], ...stores.slice(index + 1).map((other) => [store, other])]);
  const options = [];
  let optimal = true;
  for (const selected of sets) {
    let states = [{ spend: selected.map(() => 0), loyalty: 0, assignments: [] }];
    for (const line of lines) {
      const choices = priced.get(line.ingredientId).filter((choice) => selected.some((store) => store.id === choice.storeId));
      if (!choices.length) { states = []; break; }
      const next = new Map();
      for (const current of states) for (const choice of choices) {
        const index = selected.findIndex((store) => store.id === choice.storeId);
        const spend = [...current.spend]; spend[index] += choice.checkoutCents;
        const key = spend.join(":");
        const candidate = { spend, loyalty: current.loyalty + choice.loyaltyCents, assignments: [...current.assignments, choice] };
        if (!next.has(key) || next.get(key).loyalty < candidate.loyalty) next.set(key, candidate);
      }
      states = [...next.values()];
      if (states.length > 10000) { optimal = false; states.sort((a, b) => a.spend.reduce((s, n) => s + n, 0) - b.spend.reduce((s, n) => s + n, 0)); states = states.slice(0, 10000); }
    }
    const candidates = states.filter((candidate) => selected.every((store) => candidate.assignments.some((line) => line.storeId === store.id))).map((candidate) => {
      const carts = selected.map((store, index) => ({ ...store, subtotalCents: candidate.spend[index], lines: candidate.assignments.filter((line) => line.storeId === store.id) }));
      const warnings = carts.flatMap((cart) => [!cart.storeConfirmed ? `${cart.id} : point de retrait/adresse à confirmer` : null, !cart.minimumConfirmed || cart.minimumCents === null ? `${cart.id} : minimum à confirmer` : cart.subtotalCents < cart.minimumCents ? `${cart.id} : manque ${money(cart.minimumCents - cart.subtotalCents)} pour le minimum` : null, cart.feesCents === null ? `${cart.id} : frais à confirmer` : null]).filter(Boolean);
      const checkoutCents = candidate.spend.reduce((sum, value) => sum + value, 0) + carts.reduce((sum, cart) => sum + (cart.feesCents || 0), 0);
      return { carts, warnings, ready: !warnings.length, checkoutCents, loyaltyCents: candidate.loyalty, effectiveCents: checkoutCents - candidate.loyalty };
    }).sort((a, b) => Number(b.ready) - Number(a.ready) || a.checkoutCents - b.checkoutCents || a.effectiveCents - b.effectiveCents);
    if (candidates[0]) options.push(candidates[0]);
  }
  options.sort((a, b) => Number(b.ready) - Number(a.ready) || a.checkoutCents - b.checkoutCents || a.carts.length - b.carts.length || a.effectiveCents - b.effectiveCents);
  return { best: options.find((option) => option.ready) || null, options, missing: [], empty: false, optimal };
}

export function validateOffer(value) {
  assert(value && INGREDIENTS[value.ingredientId] && RETAILERS.some((store) => store.id === value.storeId), "Produit ou enseigne inconnu.");
  assert(safeText(value.id, 100) && value.id.length > 0 && Number.isFinite(value.packQuantity) && value.packQuantity > 0 && value.packQuantity <= 100000, "Conditionnement invalide.");
  assert(integer(value.priceCents, 0, 1000000) && integer(value.instantDiscountCents || 0, 0, value.priceCents) && integer(value.loyaltyCents || 0, 0, value.priceCents), "Prix ou remise invalide.");
  assert(Number.isFinite(Date.parse(value.observedAt)) && safeText(value.sourceUrl, 2000) && /^https:\/\//.test(value.sourceUrl), "Date et source HTTPS du prix requises.");
  const url = new URL(value.sourceUrl); const hosts = { carrefour: ["carrefour.fr"], leclerc: ["leclercdrive.fr", "e.leclerc"], picnic: ["picnic.app"] };
  assert(!url.username && !url.password && hosts[value.storeId].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)), "La source doit appartenir à l'enseigne.");
  for (const key of ["validFrom", "validUntil"]) if (value[key]) assert(Number.isFinite(Date.parse(value[key])), "Date de promotion invalide.");
  if (value.bundleQuantity !== undefined) assert(integer(value.bundleQuantity, 2, 100) && integer(value.bundlePriceCents, 0, value.priceCents * value.bundleQuantity), "Promotion par lot invalide.");
  return { id: value.id, ingredientId: value.ingredientId, storeId: value.storeId, packQuantity: value.packQuantity, priceCents: value.priceCents, instantDiscountCents: value.instantDiscountCents || 0, loyaltyCents: value.loyaltyCents || 0, loyaltyRequired: Boolean(value.loyaltyRequired), available: value.available !== false, observedAt: value.observedAt, sourceUrl: url.href, validFrom: value.validFrom || null, validUntil: value.validUntil || null, ...(value.bundleQuantity ? { bundleQuantity: value.bundleQuantity, bundlePriceCents: value.bundlePriceCents } : {}), label: String(value.label || INGREDIENTS[value.ingredientId].label).slice(0, 200), provenance: value.provenance === "public-page" ? "public-page" : "manual" };
}

export function applyGroceryOperation(state, operation) {
  assert(operation && safeText(operation.type, 50), "Action Courses invalide.");
  const next = structuredClone(state);
  const payload = operation.payload || {};
  switch (operation.type) {
    case "settings": {
      const allowed = ["address", "postalCode", "city", "people", "diet", "allergens", "excludedIngredients", "householdConfirmed", "days", "budgetCents", "meal", "remindAt", "reminders", "priceMaxAgeHours"];
      assert(Object.keys(payload).every((key) => allowed.includes(key)), "Réglage Courses inconnu.");
      const settings = { ...next.settings, ...payload };
      assert(safeText(settings.address, 250) && /^\d{5}$/.test(settings.postalCode) && safeText(settings.city, 100), "Adresse invalide.");
      assert(integer(settings.people, 1, 12) && [7, 14].includes(settings.days) && integer(settings.budgetCents, 0, 500000), "Foyer, période ou budget invalide.");
      assert(["all", "vegetarian", "vegan"].includes(settings.diet) && ["dinner", "lunch"].includes(settings.meal) && Array.isArray(settings.allergens) && settings.allergens.length <= 20 && settings.allergens.every((item) => safeText(item, 50)), "Contraintes alimentaires invalides.");
      assert(Array.isArray(settings.excludedIngredients) && settings.excludedIngredients.every((id) => INGREDIENTS[id]) && /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.remindAt) && [true, false].includes(settings.reminders) && integer(settings.priceMaxAgeHours, 1, 168) && typeof settings.householdConfirmed === "boolean", "Préférences invalides.");
      next.settings = settings;
      next.plan = next.plan.map((slot) => compatible(recipeFor(next, slot.recipeId), settings) ? slot : { ...slot, status: "proposed" });
      break;
    }
    case "custom-recipe": {
      assert(/^custom-[a-zA-Z0-9-]{8,80}$/.test(payload.id || "") && safeText(payload.title, 120) && payload.title.trim() && safeText(payload.subtitle || "", 180), "Titre ou identifiant de recette invalide.");
      assert(integer(payload.servings, 1, 12) && integer(payload.minutes, 1, 1440) && Array.isArray(payload.ingredients) && payload.ingredients.length > 0 && payload.ingredients.length <= 30, "Portions, durée ou ingrédients invalides.");
      assert(payload.ingredients.every((item) => INGREDIENTS[item.ingredientId] && Number.isFinite(item.quantity) && item.quantity > 0 && item.quantity <= 100000) && new Set(payload.ingredients.map((item) => item.ingredientId)).size === payload.ingredients.length, "Ingrédients ou quantités invalides.");
      assert(Array.isArray(payload.steps) && payload.steps.length > 0 && payload.steps.length <= 30 && payload.steps.every((step) => safeText(step, 500) && step.trim()), "Étapes invalides.");
      let sourceUrl = ""; if (payload.sourceUrl) { const url = new URL(payload.sourceUrl); assert(url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2000, "Lien HTTPS de recette invalide."); sourceUrl = url.href; }
      const raw = payload.ingredients.map((item) => `${item.ingredientId}:${item.quantity}`).join(" ");
      const recipe = enrichRecipe({ id: payload.id, title: payload.title.trim(), subtitle: (payload.subtitle || "").trim(), minutes: payload.minutes, category: "personnel", raw, steps: payload.steps.map((step) => step.trim()), familyId: "personal", image: { atlas: 1, cell: 0 }, imageDisclosure: "Illustration générique, non contractuelle", sourceUrl });
      recipe.servings = payload.servings; recipe.vegetarian = payload.vegetarian === true && recipe.vegetarian; recipe.vegan = payload.vegan === true && recipe.vegan && recipe.vegetarian; recipe.allergens = [...new Set([...recipe.allergens, "à vérifier sur l'étiquette"])];
      assert(!next.plan.some((slot) => slot.recipeId === recipe.id && slot.status === "accepted") || compatible(recipe, next.settings), "La recette modifiée ne respecte plus les contraintes du menu.");
      const recipes = next.customRecipes || []; assert(recipes.length < 100 || recipes.some((item) => item.id === recipe.id), "Maximum 100 recettes personnelles.");
      next.customRecipes = [...recipes.filter((item) => item.id !== recipe.id), recipe]; break;
    }
    case "custom-recipe-delete": {
      assert((next.customRecipes || []).some((item) => item.id === payload.id), "Recette personnelle introuvable.");
      assert(!next.plan.some((slot) => slot.recipeId === payload.id), "Retirez d'abord cette recette du menu.");
      next.customRecipes = next.customRecipes.filter((item) => item.id !== payload.id); delete next.preferences[payload.id]; break;
    }
    case "preference": assert(recipeFor(next, payload.recipeId) && ["favorite", "disliked", "neutral"].includes(payload.value), "Préférence recette invalide."); next.preferences[payload.recipeId] = payload.value; break;
    case "plan": assert(validDate(payload.start), "Date de menu invalide."); next.plan = proposePlan(next, payload.start); break;
    case "slot": {
      const slot = next.plan.find((item) => item.id === payload.id); assert(slot, "Repas introuvable.");
      if (payload.recipeId !== undefined) { assert(recipeFor(next, payload.recipeId) && compatible(recipeFor(next, payload.recipeId), next.settings), "Recette incompatible."); slot.recipeId = payload.recipeId; slot.status = "proposed"; }
      if (payload.status !== undefined) { assert(["proposed", "accepted", "rejected"].includes(payload.status), "Statut repas invalide."); assert(payload.status !== "accepted" || next.settings.householdConfirmed, "Confirmez le foyer et les contraintes alimentaires avant de valider les repas."); assert(payload.status !== "accepted" || compatible(recipeFor(next, slot.recipeId), next.settings), "Recette incompatible."); slot.status = payload.status; }
      if (payload.portions !== undefined) { assert(integer(payload.portions, 1, 12), "Nombre de portions invalide."); slot.portions = payload.portions; }
      break;
    }
    case "pantry": assert(INGREDIENTS[payload.ingredientId] && (payload.quantity === undefined || Number.isFinite(payload.quantity) && payload.quantity >= 0 && payload.quantity <= 100000) && (payload.skip === undefined || typeof payload.skip === "boolean"), "Stock invalide."); next.pantry[payload.ingredientId] = { ...next.pantry[payload.ingredientId], ...payload }; break;
    case "extra": assert(INGREDIENTS[payload.ingredientId] && Number.isFinite(payload.quantity) && payload.quantity >= 0 && payload.quantity <= 100000, "Produit supplémentaire invalide."); next.extras = next.extras.filter((item) => item.ingredientId !== payload.ingredientId); if (payload.quantity > 0) next.extras.push({ ingredientId: payload.ingredientId, quantity: payload.quantity }); break;
    case "store": {
      const store = next.stores.find((item) => item.id === payload.id); assert(store, "Enseigne inconnue.");
      assert(Object.keys(payload).every((key) => ["id", "enabled", "storeName", "storeConfirmed", "minimumCents", "feesCents", "minimumConfirmed", "loyalty"].includes(key)), "Réglage enseigne invalide.");
      const value = { ...store, ...payload };
      assert(safeText(value.storeName, 150) && [true, false].includes(value.enabled) && [true, false].includes(value.storeConfirmed) && [true, false].includes(value.minimumConfirmed) && [true, false].includes(value.loyalty) && (value.minimumCents === null || integer(value.minimumCents, 0, 50000)) && (value.feesCents === null || integer(value.feesCents, 0, 50000)), "Conditions magasin invalides."); Object.assign(store, value); break;
    }
    case "offer": { const offer = validateOffer(payload); next.offers = [...next.offers.filter((item) => item.id !== offer.id), offer].slice(-2000); break; }
    case "offer-delete": next.offers = next.offers.filter((item) => item.id !== payload.id); break;
    case "order": {
      assert(safeText(payload.id, 100) && RETAILERS.some((store) => store.id === payload.storeId) && validDate(payload.date) && Array.isArray(payload.lines) && payload.lines.length > 0 && payload.lines.length <= 200, "Commande importée invalide.");
      const lines = payload.lines.map((line) => { assert(INGREDIENTS[line.ingredientId] && Number.isFinite(line.quantity) && line.quantity > 0 && line.quantity <= 100000 && integer(line.priceCents, 0, 1000000), "Ligne de commande invalide."); return { ingredientId: line.ingredientId, quantity: line.quantity, priceCents: line.priceCents }; });
      next.orders = [...next.orders.filter((item) => item.id !== payload.id), { id: payload.id, storeId: payload.storeId, date: payload.date, lines, provenance: "imported" }].slice(-200); break;
    }
    default: throw new Error("Action Courses inconnue.");
  }
  return next;
}

export function frequentProducts(state) {
  const frequency = new Map();
  for (const order of state.orders) for (const id of new Set(order.lines.map((line) => line.ingredientId))) frequency.set(id, (frequency.get(id) || 0) + 1);
  return [...frequency.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, count]) => ({ ...INGREDIENTS[id], count }));
}

export function shoppingText(state, comparison = compareBaskets(state)) {
  const lines = shoppingList(state).filter((line) => line.needed > 0);
  return ["Noyau · liste de courses", ...lines.map((line) => `□ ${line.label} — ${line.needed} ${line.unit}`), "", comparison.best ? `À payer estimé sur relevés : ${money(comparison.best.checkoutCents)} ; cagnotte différée : ${money(comparison.best.loyaltyCents)}.` : "Devis incomplet : prix, frais et minimums à vérifier.", "Brouillon uniquement : aucune commande ni aucun paiement effectués."].join("\n");
}
