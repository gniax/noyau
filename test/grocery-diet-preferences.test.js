import test from 'node:test';
import assert from 'node:assert/strict';
import { initialGroceries, applyGroceryOperation, suggestions, proposePlan, compatible, shoppingList } from '../shared/groceries.js';
import { RECIPES, recipeHasMeat } from '../shared/recipes.js';
import { recipeMatches } from '../shared/recipe-discovery.js';

test('excluded foods persist and are absent from recommendations and menus', () => {
  const state = applyGroceryOperation(initialGroceries(), { type: 'settings', payload: { excludedIngredients: ['lemon'] } });
  assert.deepEqual(state.settings.excludedIngredients, ['lemon']);
  assert.ok(suggestions(state, '2026-10-31').every(r => compatible(r, state.settings)));
  assert.ok(proposePlan(state, '2026-10-31').every(slot => !RECIPES.find(r => r.id === slot.recipeId).ingredients.some(i => i.ingredientId === 'lemon')));
});
test('meat is favored and searchable without overriding vegetarian settings', () => {
  const state = initialGroceries();
  assert.ok(suggestions(state, '2026-10-31').slice(0, 12).filter(recipeHasMeat).length >= 6);
  assert.ok(RECIPES.some(r => recipeMatches(r, { filter: 'meat' })));
  state.settings.diet = 'vegetarian';
  assert.ok(suggestions(state).every(r => !recipeHasMeat(r)));
});

test('matched recipe illustrations refer to existing distinct atlas cells', async () => {
  const { RECIPE_IMAGES, RECIPES } = await import('../shared/recipes.js');
  const cells = new Set();
  for (const [id, image] of RECIPE_IMAGES) {
    const recipe = RECIPES.find(item => item.id === id);
    assert.ok(recipe?.hasMatchedImage, id);
    assert.deepEqual(recipe.image, image);
    const cell = `${image.atlas}:${image.cell}`;
    assert.ok(!cells.has(cell), cell);
    cells.add(cell);
  }
});

test('ignoring a recipe removes it from the basket and can be reversed', () => {
 let state = initialGroceries(); state.settings.householdConfirmed = true;
 state.plan = [{id:'slot', date:'2026-10-31', meal:'dinner', recipeId:RECIPES[0].id, portions:2, status:'accepted'}];
 state = applyGroceryOperation(state,{type:'preference',payload:{recipeId:RECIPES[0].id,value:'disliked'}});
 assert.equal(state.plan[0].status,'rejected'); assert.ok(!suggestions(state).some(r=>r.id===RECIPES[0].id));
 state = applyGroceryOperation(state,{type:'preference',payload:{recipeId:RECIPES[0].id,value:'neutral'}});
 assert.ok(suggestions(state).some(r=>r.id===RECIPES[0].id));
});

test('a one-meal disliked-food exception never bypasses allergies', () => {
 let state = initialGroceries(); state.settings.householdConfirmed = true; state.settings.excludedIngredients = ['broccoli'];
 state = applyGroceryOperation(state,{type:'plan',payload:{start:'2026-10-31'}}); const slot=state.plan[0];
 assert.throws(()=>applyGroceryOperation(state,{type:'slot',payload:{id:slot.id,recipeId:'recipe-03',status:'accepted'}}),/incompatible/i);
 state=applyGroceryOperation(state,{type:'slot',payload:{id:slot.id,recipeId:'recipe-03',status:'accepted',approvedExcludedIngredients:['broccoli']}});
 assert.equal(state.plan[0].status,'accepted'); assert.ok(shoppingList(state).some(item=>item.ingredientId==='broccoli' && item.needed>0));
 state=applyGroceryOperation(state,{type:'settings',payload:{allergens:['poisson']}}); assert.equal(state.plan[0].status,'proposed');
 assert.throws(()=>applyGroceryOperation(state,{type:'slot',payload:{id:slot.id,status:'accepted',approvedExcludedIngredients:['broccoli']}}),/incompatible/i);
});

test('adding an extra meal requires household confirmation and never bypasses allergies', () => {
 let state=initialGroceries(); state.settings.excludedIngredients=['broccoli'];
 const payload={id:'manual-test-1',date:'2026-11-02',meal:'dinner',portions:2,recipeId:'recipe-03',approvedExcludedIngredients:['broccoli']};
 assert.throws(()=>applyGroceryOperation(state,{type:'slot-add',payload}),/incompatible/i);
 state.settings.householdConfirmed=true;state=applyGroceryOperation(state,{type:'slot-add',payload});
 assert.equal(state.plan[0].status,'accepted');assert.ok(shoppingList(state).some(line=>line.ingredientId==='broccoli'&&line.needed>0));
 state.settings.allergens=['poisson'];
 assert.throws(()=>applyGroceryOperation(state,{type:'slot-add',payload:{...payload,id:'manual-test-2'}}),/incompatible/i);
});
