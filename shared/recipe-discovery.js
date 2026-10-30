import { INGREDIENTS, RECIPES, RECIPE_FAMILIES } from "./recipes.js";

export const normalizeRecipeSearch = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/[’']/g, " ").trim();
const indexed = new Map(RECIPES.map((recipe) => [recipe.id, normalizeRecipeSearch([
  recipe.title, recipe.subtitle, recipe.category,
  RECIPE_FAMILIES.find((family) => family.id === recipe.familyId)?.label,
  ...recipe.ingredients.map(({ ingredientId }) => INGREDIENTS[ingredientId].label),
].filter(Boolean).join(" "))]));

export function recipeMatches(recipe, { search = "", family = "all", filter = "all", preferences = {} } = {}) {
  if (family !== "all" && recipe.familyId !== family) return false;
  const searchable = indexed.get(recipe.id) || normalizeRecipeSearch([recipe.title, recipe.subtitle, ...recipe.ingredients.map(({ ingredientId }) => INGREDIENTS[ingredientId]?.label)].filter(Boolean).join(" "));
  if (!normalizeRecipeSearch(search).split(/\s+/).every((word) => searchable.includes(word))) return false;
  return filter === "all" || filter === "quick" && recipe.minutes <= 25 || filter === "vegetarian" && recipe.vegetarian
    || filter === "vegan" && recipe.vegan || filter === "favorites" && preferences[recipe.id] === "favorite"
    || filter === "budget" && recipe.estimateCents / recipe.servings <= 300;
}
