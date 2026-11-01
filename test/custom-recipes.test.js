import test from "node:test";
import assert from "node:assert/strict";
import { initialGroceries, applyGroceryOperation, recipeFor, selectedIngredientIds, sharedIngredientCount, shoppingList, suggestions } from "../shared/groceries.js";
import { menuCalendar } from "../shared/grocery-calendar.js";
import { recipeMatches } from "../shared/recipe-discovery.js";
const recipe = { id: "custom-12345678", title: "Riz maison", subtitle: "Sauce tomate", servings: 3, minutes: 25, ingredients: [{ ingredientId: "rice", quantity: 300 }, { ingredientId: "tomato", quantity: 450 }], steps: ["Cuire le riz", "Ajouter les tomates"], sourceUrl: "https://example.com/plat" };
test("personal recipe sync operation appears in discovery, plan, pantry and calendar", () => {
 let state = initialGroceries(); state = applyGroceryOperation(state, { type: "custom-recipe", payload: recipe }); const saved = recipeFor(state, recipe.id);
 assert.equal(saved.servings, 3); assert.equal(saved.sourceUrl, recipe.sourceUrl); assert.equal(recipeMatches(saved, { search: "riz maison" }), true); assert.equal(state.customRecipes.length, 1);
 state.settings.householdConfirmed = true; state = applyGroceryOperation(state, { type: "plan", payload: { start: "2026-10-28" } }); state = applyGroceryOperation(state, { type: "slot", payload: { id: state.plan[0].id, recipeId: recipe.id, status: "accepted", portions: 6 } });
 assert.equal(shoppingList(state).find((x) => x.ingredientId === "rice").quantity, 600); assert.match(menuCalendar(state), /Riz maison/); assert.throws(() => applyGroceryOperation(state, { type: "custom-recipe-delete", payload: { id: recipe.id } }), /menu/);
});
test("recommendations prioritize shared ingredients without surfacing excluded recipes", () => {
 let state = initialGroceries(); state = applyGroceryOperation(state, { type: "custom-recipe", payload: recipe }); state.settings.householdConfirmed = true; state = applyGroceryOperation(state, { type: "plan", payload: { start: "2026-10-28" } }); state = applyGroceryOperation(state, { type: "slot", payload: { id: state.plan[0].id, recipeId: recipe.id, status: "accepted" } });
 const selected = selectedIngredientIds(state), choices = suggestions(state).filter((item) => item.id !== recipe.id); assert.ok(choices.length > 10); const counts = choices.map((item) => sharedIngredientCount(item, selected)); assert.ok(counts[0] > 0); assert.ok(counts.every((n, i) => i === 0 || n <= counts[i - 1]));
});
test("personal recipes reject duplicate ingredients and remain conservative for allergens", () => {
 const state = initialGroceries(); assert.throws(() => applyGroceryOperation(state, { type: "custom-recipe", payload: { ...recipe, ingredients: [recipe.ingredients[0], recipe.ingredients[0]] } }), /Ingrédients/);
 const saved = applyGroceryOperation(state, { type: "custom-recipe", payload: recipe }); saved.settings.allergens = ["lait"]; assert.equal(suggestions(saved).some((item) => item.id === recipe.id), false);
});

test('imported AI estimate disclosures survive saving and editing', () => {
 const source = {...recipe, inferredSteps:true, inferredQuantities:true};
 const state = applyGroceryOperation(initialGroceries(), {type:'custom-recipe', payload:source});
 assert.equal(state.customRecipes[0].inferredSteps,true); assert.equal(state.customRecipes[0].inferredQuantities,true);
});

test('new personal recipes become favorites but edits preserve explicit preference', () => {
 let state = applyGroceryOperation(initialGroceries(), {type:'custom-recipe',payload:recipe});
 assert.equal(state.preferences[recipe.id], 'favorite');
 state = applyGroceryOperation(state, {type:'preference',payload:{recipeId:recipe.id,value:'neutral'}});
 state = applyGroceryOperation(state, {type:'custom-recipe',payload:{...recipe,title:'Recette modifiée'}});
 assert.equal(state.preferences[recipe.id], 'neutral');
});
