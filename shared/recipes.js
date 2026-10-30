// Original recipe ideas. Prices are transparent planning references, never retailer quotes.
import { expandedRecipeRows, RECIPE_FAMILIES } from "./recipe-collections.js";
export { RECIPE_FAMILIES };
export const INGREDIENTS = Object.fromEntries([
  ["chicken", "Poulet", "g", 1100, 1000, "🥩"], ["potato", "Pommes de terre", "g", 220, 1000, "🥔"],
  ["lemon", "Citron", "unit", 55, 1, "🍋"], ["pasta", "Pâtes", "g", 180, 1000, "🍝"],
  ["tomato", "Tomates", "g", 330, 1000, "🍅"], ["tomato-can", "Tomates concassées", "g", 240, 1000, "🥫"],
  ["rice", "Riz", "g", 230, 1000, "🍚"], ["salmon", "Saumon", "g", 2200, 1000, "🐟"],
  ["broccoli", "Brocoli", "g", 300, 1000, "🥦"], ["mushroom", "Champignons", "g", 500, 1000, "🍄"],
  ["cream", "Crème", "ml", 460, 1000, "🥛"], ["onion", "Oignons", "g", 180, 1000, "🧅"],
  ["chickpea", "Pois chiches cuits", "g", 290, 1000, "🫘"], ["spinach", "Épinards", "g", 400, 1000, "🥬"],
  ["coconut", "Lait de coco", "ml", 480, 1000, "🥥"], ["beef", "Bœuf haché", "g", 1200, 1000, "🥩"],
  ["zucchini", "Courgettes", "g", 250, 1000, "🥒"], ["aubergine", "Aubergines", "g", 330, 1000, "🍆"],
  ["pepper", "Poivrons", "g", 450, 1000, "🫑"], ["tortilla", "Tortillas", "unit", 35, 1, "🫓"],
  ["egg", "Œufs", "unit", 32, 1, "🥚"], ["pastry", "Pâte à tarte", "unit", 145, 1, "🥧"],
  ["salad", "Salade", "g", 600, 1000, "🥬"], ["white-fish", "Poisson blanc", "g", 1400, 1000, "🐟"],
  ["pea", "Petits pois", "g", 280, 1000, "🟢"], ["milk", "Lait", "ml", 120, 1000, "🥛"],
  ["couscous", "Semoule", "g", 190, 1000, "🌾"], ["carrot", "Carottes", "g", 150, 1000, "🥕"],
  ["lentil", "Lentilles sèches", "g", 350, 1000, "🫘"], ["feta", "Feta", "g", 1100, 1000, "🧀"],
  ["noodle", "Nouilles", "g", 380, 1000, "🍜"], ["soy-sauce", "Sauce soja", "ml", 650, 1000, "🥢"],
  ["cheese", "Fromage râpé", "g", 900, 1000, "🧀"], ["black-bean", "Haricots noirs cuits", "g", 330, 1000, "🫘"],
  ["corn", "Maïs", "g", 320, 1000, "🌽"], ["avocado", "Avocat", "unit", 110, 1, "🥑"],
  ["gnocchi", "Gnocchis", "g", 420, 1000, "🥔"], ["mozzarella", "Mozzarella", "g", 800, 1000, "🧀"],
  ["pesto", "Pesto", "g", 1300, 1000, "🌿"], ["sweet-potato", "Patate douce", "g", 300, 1000, "🍠"],
  ["red-lentil", "Lentilles corail sèches", "g", 380, 1000, "🫘"], ["pumpkin", "Courge", "g", 220, 1000, "🎃"],
  ["white-bean", "Haricots blancs cuits", "g", 280, 1000, "🫘"], ["tuna", "Thon égoutté", "g", 1400, 1000, "🐟"],
  ["olive", "Olives", "g", 650, 1000, "🫒"], ["tofu", "Tofu", "g", 800, 1000, "🧊"],
  ["flour", "Farine", "g", 110, 1000, "🌾"], ["yogurt", "Yaourt nature", "g", 250, 1000, "🥛"],
  ["cucumber", "Concombre", "g", 250, 1000, "🥒"], ["pita", "Pains pita", "unit", 45, 1, "🫓"],
  ["sausage", "Saucisses", "g", 900, 1000, "🌭"], ["quinoa", "Quinoa", "g", 650, 1000, "🌾"],
  ["mustard", "Moutarde", "g", 500, 1000, "🟡"], ["oil", "Huile d'olive", "ml", 900, 1000, "🫒"],
  ["garlic", "Ail", "g", 800, 1000, "🧄"], ["curry", "Curry en poudre", "g", 2500, 1000, "🌶️"],
  ["bread", "Pain", "g", 400, 1000, "🥖"], ["coffee", "Café", "g", 1500, 1000, "☕"],
  ["apple", "Pommes", "g", 280, 1000, "🍎"], ["banana", "Bananes", "g", 210, 1000, "🍌"],
  ["leek", "Poireaux", "g", 300, 1000, "🥬"], ["cauliflower", "Chou-fleur", "g", 300, 1000, "🥦"],
  ["green-bean", "Haricots verts", "g", 400, 1000, "🫛"], ["cabbage", "Chou", "g", 190, 1000, "🥬"],
  ["beetroot", "Betteraves cuites", "g", 280, 1000, "🟣"], ["fennel", "Fenouil", "g", 350, 1000, "🌿"],
  ["turnip", "Navets", "g", 220, 1000, "🥬"], ["turkey", "Dinde", "g", 1200, 1000, "🥩"],
  ["shrimp", "Crevettes décortiquées", "g", 1800, 1000, "🦐"], ["goat-cheese", "Fromage de chèvre", "g", 1400, 1000, "🧀"],
  ["ricotta", "Ricotta", "g", 650, 1000, "🧀"], ["cheddar", "Cheddar", "g", 1100, 1000, "🧀"],
  ["parmesan", "Parmesan", "g", 1900, 1000, "🧀"], ["bulgur", "Boulgour", "g", 300, 1000, "🌾"],
  ["red-bean", "Haricots rouges cuits", "g", 280, 1000, "🫘"], ["peanut", "Cacahuètes", "g", 700, 1000, "🥜"],
  ["almond", "Amandes", "g", 1400, 1000, "🌰"], ["walnut", "Noix", "g", 1500, 1000, "🌰"],
  ["sesame", "Graines de sésame", "g", 1100, 1000, "🌾"], ["ginger", "Gingembre", "g", 1000, 1000, "🫚"],
  ["paprika", "Paprika", "g", 2400, 1000, "🌶️"], ["cumin", "Cumin", "g", 2600, 1000, "🌶️"],
  ["herbs", "Herbes séchées", "g", 4000, 1000, "🌿"], ["parsley", "Persil", "g", 2000, 1000, "🌿"],
  ["vinegar", "Vinaigre", "ml", 250, 1000, "🍶"], ["caper", "Câpres", "g", 1200, 1000, "🫒"],
  ["raisin", "Raisins secs", "g", 650, 1000, "🍇"], ["dark-chocolate", "Chocolat noir", "g", 1200, 1000, "🍫"],
  ["pizza-dough", "Pâte à pizza", "unit", 150, 1, "🍕"], ["burger-bun", "Pains à burger", "unit", 50, 1, "🍔"],
].map(([id, label, unit, referenceCents, referenceQuantity, icon]) => [id, { id, label, unit, referenceCents, referenceQuantity, icon }]));

const ALLERGENS = {
  pasta: ["gluten"], noodle: ["gluten", "œuf"], tortilla: ["gluten"], pastry: ["gluten", "lait"], couscous: ["gluten"], flour: ["gluten"], bread: ["gluten"], pita: ["gluten"],
  egg: ["œuf"], salmon: ["poisson"], "white-fish": ["poisson"], tuna: ["poisson"], tofu: ["soja"], "soy-sauce": ["soja", "gluten"],
  milk: ["lait"], cream: ["lait"], cheese: ["lait"], feta: ["lait"], mozzarella: ["lait"], yogurt: ["lait"], pesto: ["lait", "fruits à coque"], mustard: ["moutarde"], gnocchi: ["gluten", "œuf"], sausage: ["à vérifier sur l'étiquette"],
  "goat-cheese": ["lait"], ricotta: ["lait"], cheddar: ["lait"], parmesan: ["lait"], bulgur: ["gluten"],
  shrimp: ["crustacés"], peanut: ["arachides"], almond: ["fruits à coque"], walnut: ["fruits à coque"], sesame: ["sésame"],
  "dark-chocolate": ["lait", "soja"], "pizza-dough": ["gluten"], "burger-bun": ["gluten", "œuf", "lait", "sésame"],
};
const MEAT = new Set(["chicken", "beef", "sausage", "turkey"]);
const FISH = new Set(["salmon", "white-fish", "tuna", "shrimp"]);
const parse = (text) => text.split(" ").map((entry) => { const [ingredientId, quantity] = entry.split(":"); return { ingredientId, quantity: Number(quantity) }; });
const rows = [
  ["Poulet rôti au citron", "Pommes grenailles & jus aux herbes", 40, "four", "chicken:300 potato:500 lemon:1 oil:15 garlic:6", "Faites chauffer le four à 200 °C.|Coupez les pommes de terre et enrobez-les d'huile et d'herbes.|Ajoutez le poulet et le citron, enfournez jusqu'à cuisson complète du poulet à cœur.|Servez avec le jus de cuisson."],
  ["Spaghetti tomate & basilic", "Le classique qui met tout le monde d'accord", 20, "rapide", "pasta:180 tomato-can:400 onion:80 oil:15 garlic:6", "Émincez l'oignon et faites-le revenir dans l'huile.|Ajoutez l'ail et les tomates, laissez réduire 15 minutes.|Faites cuire les pâtes selon le paquet.|Mélangez et ajoutez des herbes fraîches."],
  ["Saumon, riz & brocoli", "Citron frais, assiette colorée", 25, "poisson", "salmon:280 rice:140 broccoli:400 lemon:1 oil:10", "Lancez le riz selon les indications du paquet.|Faites cuire les fleurettes de brocoli à la vapeur.|Faites cuire le saumon jusqu'à cuisson complète, selon son épaisseur.|Servez avec le citron et un filet d'huile."],
  ["Risotto forestier", "Champignons dorés, texture crémeuse", 35, "réconfort", "rice:170 mushroom:300 cream:80 onion:80 cheese:40 oil:10", "Émincez l'oignon et les champignons.|Faites-les revenir avec l'huile, puis ajoutez le riz.|Ajoutez de l'eau chaude ou du bouillon progressivement en remuant jusqu'à cuisson du riz.|Terminez avec la crème et le fromage."],
  ["Curry de pois chiches", "Épinards & douceur de coco", 25, "rapide", "chickpea:400 spinach:250 coconut:200 rice:140 onion:80 curry:6 oil:10", "Faites revenir l'oignon avec l'huile et le curry.|Ajoutez les pois chiches égouttés et le lait de coco.|Laissez mijoter, ajoutez les épinards en fin de cuisson.|Servez avec le riz cuit séparément."],
  ["Boulettes à l'italienne", "Sauce tomate & spaghetti", 30, "famille", "beef:280 pasta:180 tomato-can:400 onion:80 oil:10", "Façonnez de petites boulettes avec le bœuf et des herbes.|Faites-les dorer, ajoutez l'oignon et la tomate.|Laissez mijoter jusqu'à cuisson complète des boulettes à cœur.|Servez sur les pâtes cuites selon le paquet."],
  ["Ratatouille & pois chiches", "Les légumes du soleil au four", 40, "four", "zucchini:250 aubergine:250 tomato:300 chickpea:250 onion:80 oil:20", "Préchauffez le four à 200 °C.|Coupez les légumes en morceaux de taille régulière.|Mélangez avec l'huile, des herbes et les pois chiches égouttés.|Enfournez et remuez à mi-cuisson, jusqu'à légumes tendres."],
  ["Fajitas de poulet", "Poivrons rôtis, à composer à table", 25, "famille", "chicken:280 pepper:300 tortilla:4 onion:80 yogurt:100 oil:10", "Émincez le poulet, l'oignon et les poivrons.|Faites revenir les légumes puis le poulet jusqu'à cuisson complète à cœur.|Réchauffez les tortillas.|Garnissez et ajoutez le yaourt assaisonné."],
  ["Quiche verte du marché", "Épinards, œufs & petite salade", 40, "four", "pastry:1 egg:3 spinach:250 cream:120 cheese:40 salad:100", "Préchauffez le four à 180 °C.|Faites tomber les épinards et égouttez-les.|Battez les œufs avec la crème, ajoutez épinards et fromage.|Versez sur la pâte et cuisez jusqu'à appareil pris et pâte dorée ; servez avec la salade."],
  ["Poisson & écrasé de pommes de terre", "Petits pois et citron", 30, "poisson", "white-fish:300 potato:450 pea:200 milk:80 lemon:1 oil:10", "Faites cuire les pommes de terre dans l'eau.|Écrasez-les avec le lait chaud.|Faites cuire le poisson jusqu'à cuisson complète et les petits pois séparément.|Servez avec le citron."],
  ["Couscous de légumes", "Semoule moelleuse & pois chiches", 30, "famille", "couscous:160 carrot:200 zucchini:250 chickpea:250 tomato-can:200 onion:80 oil:15", "Coupez les légumes en morceaux.|Faites revenir l'oignon, ajoutez légumes, tomates et un peu d'eau.|Laissez mijoter jusqu'à légumes tendres, ajoutez les pois chiches.|Préparez la semoule selon le paquet et servez ensemble."],
  ["Salade de lentilles & feta", "Carottes, herbes et fraîcheur", 30, "batch", "lentil:160 carrot:200 feta:100 onion:60 lemon:1 oil:15", "Rincez les lentilles et faites-les cuire selon le paquet.|Râpez les carottes et émincez l'oignon.|Mélangez avec les lentilles tiédies, le jus de citron et l'huile.|Émiettez la feta au dernier moment."],
  ["Nouilles sautées au poulet", "Brocoli croquant & sauce soja", 25, "rapide", "noodle:180 chicken:250 broccoli:350 soy-sauce:25 oil:10", "Préparez les nouilles selon le paquet.|Découpez le poulet et le brocoli en petits morceaux.|Faites cuire le poulet complètement à cœur, ajoutez le brocoli.|Ajoutez nouilles et sauce soja, faites sauter ensemble."],
  ["Gratin courgettes & tomates", "Une croûte dorée, tout simplement", 40, "four", "zucchini:500 tomato:300 cheese:100 cream:100 oil:10", "Préchauffez le four à 190 °C.|Coupez les légumes en fines rondelles.|Répartissez dans un plat avec la crème et le fromage.|Enfournez jusqu'à légumes tendres et dessus doré."],
  ["Bowl mexicain", "Haricots noirs, maïs & avocat", 20, "rapide", "black-bean:300 corn:150 avocado:1 tomato:200 rice:140 lemon:1", "Faites cuire le riz selon le paquet.|Égouttez et rincez les haricots et le maïs.|Coupez tomates et avocat, citronnez.|Disposez les ingrédients dans deux bols et assaisonnez."],
  ["Gnocchis, tomates & mozzarella", "Pesto et basilic, esprit dolce vita", 20, "rapide", "gnocchi:400 tomato:250 mozzarella:125 pesto:40 oil:10", "Faites dorer les gnocchis dans un peu d'huile selon le paquet.|Ajoutez les tomates coupées et laissez-les fondre.|Ajoutez le pesto hors du feu.|Terminez avec la mozzarella et des herbes."],
  ["Patate douce rôtie & feta", "Pois chiches, épinards et citron", 35, "four", "sweet-potato:500 chickpea:250 spinach:150 feta:100 lemon:1 oil:15", "Préchauffez le four à 200 °C.|Coupez la patate douce en cubes et faites-la rôtir avec l'huile.|Ajoutez les pois chiches en fin de cuisson.|Servez sur les épinards, avec feta et citron."],
  ["Velouté carottes & lentilles corail", "Un bol tout doux pour les soirs frais", 30, "batch", "red-lentil:160 carrot:400 coconut:150 onion:80 curry:4 oil:10", "Faites revenir l'oignon et les épices.|Ajoutez les carottes, les lentilles rincées et de l'eau à hauteur.|Laissez cuire jusqu'à tendreté, ajoutez le lait de coco.|Mixez et ajustez la texture avec un peu d'eau."],
  ["Courgettes farcies au riz", "Tomates, herbes & fromage gratiné", 40, "four", "zucchini:600 rice:140 tomato-can:250 cheese:80 onion:80 oil:10", "Préchauffez le four à 190 °C.|Faites cuire le riz, puis mélangez-le aux tomates et à l'oignon revenu.|Évidez les courgettes, garnissez-les.|Ajoutez le fromage et enfournez jusqu'à légumes tendres."],
  ["Poulet coco & curry", "Riz parfumé, sauce onctueuse", 30, "famille", "chicken:280 coconut:200 rice:140 onion:100 carrot:200 curry:6 oil:10", "Faites revenir l'oignon et le poulet coupé en petits morceaux.|Ajoutez les carottes, le curry et le lait de coco.|Laissez mijoter jusqu'à cuisson complète du poulet et des carottes.|Servez avec le riz cuit séparément."],
  ["Omelette du marché", "Champignons, tomates & salade", 20, "rapide", "egg:4 mushroom:200 tomato:200 salad:100 oil:10", "Faites revenir les champignons et les tomates.|Battez les œufs et versez sur les légumes.|Laissez prendre à feu doux jusqu'à la cuisson souhaitée.|Servez avec une salade assaisonnée."],
  ["Couscous de courge rôtie", "Pois chiches et feta émiettée", 35, "four", "pumpkin:500 couscous:160 chickpea:250 feta:80 oil:15", "Préchauffez le four à 200 °C.|Coupez la courge en cubes, enrobez d'huile et faites rôtir.|Préparez la semoule et réchauffez les pois chiches.|Assemblez avec la feta."],
  ["Mijoté de haricots blancs", "Carottes & tomates aux herbes", 30, "batch", "white-bean:400 carrot:250 tomato-can:300 onion:100 oil:15 garlic:6", "Faites revenir l'oignon et les carottes.|Ajoutez les tomates et un peu d'eau, laissez cuire jusqu'à carottes tendres.|Ajoutez les haricots égouttés et l'ail.|Poursuivez quelques minutes et servez bien chaud."],
  ["Salade de pâtes au thon", "Tomates, olives & citron", 20, "batch", "pasta:180 tuna:160 tomato:250 olive:60 lemon:1 oil:15", "Cuisez les pâtes et rafraîchissez-les.|Égouttez le thon, coupez tomates et olives.|Mélangez avec les pâtes, le citron et l'huile.|Conservez au frais si préparé à l'avance."],
  ["Tofu sauté au brocoli", "Riz & sauce soja", 25, "rapide", "tofu:300 broccoli:400 rice:140 soy-sauce:25 oil:15", "Faites cuire le riz.|Séchez le tofu et coupez-le en cubes.|Faites dorer le tofu, ajoutez le brocoli et un peu d'eau pour l'attendrir.|Ajoutez la sauce soja et servez."],
  ["Bolognaise de lentilles", "Une sauce généreuse, sans viande", 35, "batch", "lentil:140 pasta:180 tomato-can:400 carrot:150 onion:100 oil:15", "Faites cuire les lentilles selon le paquet.|Faites revenir oignon et carotte coupés finement.|Ajoutez tomate et lentilles, laissez mijoter.|Servez avec les spaghetti cuits à part."],
  ["Crêpes épinards & fromage", "Une poêlée fondante et dorée", 30, "famille", "flour:120 egg:2 milk:200 spinach:300 cheese:100 oil:10", "Battez farine, œufs et lait pour former une pâte.|Faites cuire de fines crêpes dans une poêle huilée.|Faites tomber les épinards, égouttez et mélangez au fromage.|Garnissez les crêpes et réchauffez-les."],
  ["Pita façon falafels", "Pois chiches, concombre & yaourt", 30, "famille", "chickpea:350 pita:4 cucumber:250 yogurt:150 flour:30 lemon:1 oil:20", "Écrasez les pois chiches égouttés avec la farine et des herbes.|Façonnez de petites galettes et faites-les dorer.|Coupez le concombre et préparez une sauce yaourt-citron.|Garnissez les pains pita réchauffés."],
  ["Saucisses & lentilles", "Le plat familial des jours frais", 40, "réconfort", "sausage:280 lentil:160 carrot:250 onion:100 oil:10", "Rincez les lentilles.|Faites revenir l'oignon, les carottes et les saucisses.|Ajoutez les lentilles et l'eau selon le paquet.|Laissez mijoter jusqu'à cuisson complète des saucisses à cœur et tendreté des lentilles."],
  ["Quinoa méditerranéen", "Légumes rôtis & feta", 35, "four", "quinoa:150 zucchini:250 pepper:200 aubergine:200 feta:100 oil:15", "Préchauffez le four à 200 °C.|Coupez les légumes, enrobez d'huile et faites-les rôtir.|Rincez et cuisez le quinoa selon le paquet.|Assemblez et ajoutez la feta."],
  ["Tarte tomate & moutarde", "Pâte dorée, fraîcheur du marché", 35, "four", "pastry:1 tomato:500 mustard:30 cheese:70 salad:100", "Préchauffez le four à 190 °C.|Déroulez la pâte et étalez la moutarde.|Ajoutez les tomates en rondelles et le fromage.|Cuisez jusqu'à pâte bien dorée ; servez avec la salade."],
  ["Poisson mijoté à la tomate", "Pommes de terre & herbes fraîches", 35, "poisson", "white-fish:300 potato:400 tomato-can:400 onion:100 oil:15 garlic:6", "Faites revenir l'oignon et l'ail.|Ajoutez les pommes de terre en petits dés, les tomates et un peu d'eau.|Laissez mijoter jusqu'à pommes de terre tendres.|Ajoutez le poisson et poursuivez jusqu'à cuisson complète à cœur."],
];

export function enrichRecipe(recipe) {
  const { raw } = recipe;
  const ingredients = parse(raw);
  const allergens = [...new Set(ingredients.flatMap(({ ingredientId }) => ALLERGENS[ingredientId] || []))];
  const meat = ingredients.some(({ ingredientId }) => MEAT.has(ingredientId));
  const fish = ingredients.some(({ ingredientId }) => FISH.has(ingredientId));
  return { ...recipe, raw: undefined, servings: 2, ingredients, allergens,
    vegetarian: !meat && !fish, vegan: !meat && !fish && !allergens.some((item) => ["œuf", "lait"].includes(item)),
    difficulty: "Facile",
    estimateCents: Math.round(ingredients.reduce((total, { ingredientId, quantity }) => total + INGREDIENTS[ingredientId].referenceCents * quantity / INGREDIENTS[ingredientId].referenceQuantity, 0)),
  };
}

export const RECIPES = [
  ...rows.map(([title, subtitle, minutes, category, raw, instructions], index) => enrichRecipe({ id: `recipe-${String(index + 1).padStart(2, "0")}`, title, subtitle, minutes, category, raw, steps: instructions.split("|"), familyId: "essentials", image: { atlas: index < 16 ? 1 : 2, cell: index % 16 }, imageDisclosure: "Illustration générée, présentation indicative" })),
  ...expandedRecipeRows(INGREDIENTS).map(enrichRecipe),
];

export const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((recipe) => [recipe.id, recipe]));
