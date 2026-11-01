// Real, dated prices from two public sources: E.Leclerc digital catalogues and Open Prices (Open Food Facts).
// Nothing here estimates a price: every record carries its source, date and place.
import { INGREDIENTS } from "../shared/recipes.js";
import { parseLeclercCatalogues } from "./grocery-catalogues.js";
import { SessionStore } from "./session-store.js";
import { robotsAllows } from "./recipe-import.js";
import sharp from "sharp";

const USER_AGENT = "NoyauCatalogue/1.0 (usage personnel)";
const OPEN_PRICES = "https://prices.openfoodfacts.org/api/v1";
const READY_MEAL = /\b(sauce|cuisin[ée]e?s?|plats?|soupes?|velout[ée]s?|mouslines?|chips|biscuits?|g[aâ]teaux?|desserts?|chats?|chiens?|b[ée]b[ée]s?|compotes?|pizzas?|sandwich|raviolis?|lasagnes?|quiches?|tartes?|nuggets?|pan[ée]e?s?|bonbons?|glaces?|sorbets?|boissons?|jus|sirops?|nectar|smoothies?|gourdes?|croquettes?|samoussas?|nems?|rillettes?|farcie?s?|tartinables?|houmous|salade compos[ée]e|taboul[ée]|parmentier|gratin|poêlée|po[eê]l[ée]e|couscous royal|micro-?ond\w*|cr[eè]mes? dessert|chocolat|cookies?|barres?|c[ée]r[ée]ales|muesli|granola|mix|apéri\w*|croustilles|lessive|shampo\w*|gel douche|rougail|braisée?s?|so[sß]+e|curly|halva|quinotto|pringles|saucisses? de thon|blanquette|cassoulet|tajine|paella|choucroute|carr[ée] gourmand|galette|pr[ée]par[ée]e?s?)\b/i;

const COMPOSED = /(?:^|\s)(aux?|à la|à l'|et|&|fa[cç]on|avec|sur lit|garnie?s?|fourr[ée]e?s?|saveur|go[uû]t)(?:\s|$)/i;
// name: French shelf label, tags: Open Food Facts categories. keepMeals skips the ready-meal filter.
const M = (name, tags = [], reject = null, keepMeals = false) => ({ name, tags, reject, keepMeals });
export const INGREDIENT_MATCHERS = {
  chicken: M(/\b(filets? de poulet|escalopes? de poulet|blancs? de poulet|poulet (entier|fermier|blanc|jaune|noir)|cuisses? de poulet|aiguillettes? de poulet)\b/i, ["en:chicken-breasts", "en:chicken-fillets", "en:chickens"], /r[oô]ti|cuit|grignott|mexicain|fum[ée]/i),
  potato: M(/\bpommes? de terre\b/i, ["en:potatoes"], /frite|pur[ée]e|flocon|surgel|four/i),
  lemon: M(/^citrons?\b/i, ["en:lemons"], /jus|confit|sucre|limonade|tarte/i),
  pasta: M(/\b(p[aâ]tes|spaghetti|penne|fusilli|coquillettes|tagliatelles|torsades|macaroni|farfalle)\b/i, ["en:pastas", "en:spaghetti", "en:penne", "en:fusilli"], /farcies?|fra[iî]ches?|bolognaise|carbonara|instant|bris[ée]e|feuillet[ée]e|tarte|pizza|sans gluten/i),
  tomato: M(/^tomates?\b/i, ["en:tomatoes"], /ketchup|coulis|concentr|concass|pel[ée]es|s[ée]ch|pur[ée]e|cerise/i),
  "tomato-can": M(/\btomates? (concass|pel[ée]es|enti[eè]res pel)|concass[ée]e? de tomates?|pulpe de tomates?|tomates? en d[ée]s\b/i, ["en:canned-tomatoes", "en:peeled-tomatoes", "en:crushed-tomatoes", "en:diced-tomatoes"]),
  rice: M(/\briz\b/i, ["en:rices", "en:long-grain-rices", "en:basmati-rices", "en:thai-rices"], /au lait|gal[eé]t|souffl|cake|vinaigre|boisson|lait de riz|croustillant|chocolat/i),
  salmon: M(/\b(pav[ée]s?|filets?) de saumon\b/i, ["en:salmons", "en:salmon-fillets"], /fum[ée]|rillette|tartare|gravlax/i),
  broccoli: M(/\bbrocolis?\b/i, ["en:broccoli", "en:broccolis"], /soupe|pur[ée]e/i),
  mushroom: M(/\bchampignons?\b/i, ["en:mushrooms", "en:button-mushrooms", "en:cultivated-mushrooms"], /persill|cuisin|conserve|surgel|sauce|pizza|lardons|galette/i),
  cream: M(/\bcr[eè]me (fra[iî]che|liquide|enti[eè]re|l[ée]g[eè]re|semi|[ée]paisse)/i, ["en:creams", "en:fresh-creams", "en:cooking-creams"], /glac[ée]e|dessert|mains|visage|caramel|marron/i),
  onion: M(/^oignons?\b/i, ["en:onions", "en:yellow-onions"], /frit|confit|soupe|rouge/i),
  chickpea: M(/\bpois chiches?\b/i, ["en:chickpeas", "en:canned-chickpeas"], /houmous|farine|cuisin/i),
  spinach: M(/\b[ée]pinards?\b/i, ["en:spinachs", "en:spinaches"], /quiche|pur[ée]e|cr[eè]me|tarte/i),
  coconut: M(/\b(lait|cr[eè]me) de coco\b/i, ["en:coconut-milks", "en:coconut-milk", "en:coconut-milks-and-creams"], /boisson|yaourt|dessert|perle/i),
  beef: M(/\b(b[oœ]uf hach|steaks? hach[ée]s?|hach[ée] de b[oœ]uf)/i, ["en:ground-beef", "en:ground-beefs", "en:beef-steak-hache", "en:minced-beef"], /cuit|burger|bolognaise/i),
  zucchini: M(/\bcourgettes?\b/i, ["en:zucchini", "en:zucchinis", "en:courgettes"], /soupe|gratin|po[eê]l[ée]e/i),
  aubergine: M(/\baubergines?\b/i, ["en:eggplants", "en:aubergines"], /caviar|grill|po[eê]l[ée]e/i),
  pepper: M(/\bpoivrons?\b/i, ["en:bell-peppers", "en:peppers", "en:sweet-peppers"], /grill|marin|farci|cuisin/i),
  tortilla: M(/\btortillas? de bl[ée]\b/i, ["en:wheat-tortillas", "en:wraps"], /chips/i),
  egg: M(/\b(\d+\s*)?[oœ]ufs? (frais|plein air|de poules?|bio|moyens?|gros)|^(\d+\s+)?[oœ]ufs\b/i, ["en:chicken-eggs", "en:eggs", "en:free-range-chicken-eggs", "en:organic-eggs"], /chocolat|p[aâ]ques|mimosa|mayonnaise/i),
  pastry: M(/\bp[aâ]te (bris[ée]e|feuillet[ée]e|sabl[ée]e)\b/i, ["en:shortcrust-pastries", "en:puff-pastries", "en:pie-doughs", "en:pastry-dough"]),
  salad: M(/^(salade (verte|m[ée]lang[ée]e|laitue|batavia|feuille)|laitue|batavia|mesclun|roquette|m[aâ]che)\b/i, ["en:lettuces", "en:salads", "en:green-salads", "en:lamb-s-lettuces"], /compos|thon|c[ée]sar|p[aâ]tes|fruits/i),
  "white-fish": M(/\b(filets? de (colin|cabillaud|lieu|merlu|merlan)|dos de cabillaud)\b/i, ["en:cod-fillets", "en:hake-fillets", "en:pollock-fillets", "en:white-fish"], /pan[ée]|meuni[eè]re|cuisin/i),
  pea: M(/\bpetits? pois\b/i, ["en:peas", "en:garden-peas", "en:canned-peas", "en:frozen-peas"], /carottes|chiche/i),
  milk: M(/^lait\b.*\b(demi|[ée]cr[ée]m|entier|uht)/i, ["en:semi-skimmed-milks", "en:milks", "en:whole-milks", "en:uht-milks"], /coco|soja|amande|avoine|croissance|chocolat|infantile/i),
  couscous: M(/\b(semoule|couscous)\b/i, ["en:couscous", "en:semolina", "en:durum-wheat-semolinas"], /royal|poulet|l[ée]gumes|merguez|cuisin|dessert|gâteau|lait|vanille/i),
  carrot: M(/\bcarottes?\b/i, ["en:carrots"], /r[aâ]p|jus|pur[ée]e|soupe|petits pois|baby/i),
  lentil: M(/\blentilles?\b(?!.*corail)/i, ["en:lentils", "en:green-lentils", "en:dried-lentils"], /saucisse|cuisin|petit sal[ée]|corail|auvergnate|pr[ée]par/i),
  feta: M(/\bfeta\b/i, ["en:fetas"], /tomates?|olive|cubes? marin/i),
  noodle: M(/\bnouilles?\b/i, ["en:noodles", "en:egg-noodles", "en:asian-noodles"], /instant|saveur|poulet|cr[eè]vette|b[oœ]uf|bol|cup/i),
  "soy-sauce": M(/\bsauce soja\b/i, ["en:soy-sauces"], null, true),
  cheese: M(/\b(emmental|fromage) r[aâ]p[ée]|r[aâ]p[ée] (emmental|fromage)/i, ["en:grated-cheeses", "en:grated-emmentals"], null),
  "black-bean": M(/\bharicots? noirs?\b/i, ["en:black-beans"]),
  corn: M(/\bma[iï]s\b/i, ["en:corn", "en:canned-corn", "en:sweet-corn", "en:sweet-corns"], /pop|galette|tortilla|farine|souffl|huile|fécule/i),
  avocado: M(/^avocats?\b/i, ["en:avocados"], /huile|guacamole/i),
  gnocchi: M(/\bgnocchis?\b/i, ["en:gnocchi", "en:potato-gnocchi"], /farcis|fromage|ch[eè]vre|[ée]pinards|po[eê]l/i),
  mozzarella: M(/\bmozzarella\b/i, ["en:mozzarella", "en:mozzarellas"], /pizza|sticks?|pan[ée]/i),
  pesto: M(/\bpesto\b/i, ["en:pesto", "en:pestos", "en:green-pesto"], null, true),
  "sweet-potato": M(/\bpatates? douces?\b/i, ["en:sweet-potatoes"], /chips|frites|pur[ée]e/i),
  "red-lentil": M(/\blentilles? corail\b/i, ["en:red-lentils", "en:coral-lentils"], /cuisin|soupe/i),
  pumpkin: M(/\b(potimarron|butternut|courge|potiron)\b/i, ["en:pumpkins", "en:squashes", "en:butternut-squashes", "en:winter-squashes"], /soupe|velout|graines|pur[ée]e/i),
  "white-bean": M(/\b(haricots? blancs?|lingots|cocos? de paimpol)\b/i, ["en:white-beans", "en:canned-white-beans"], /sauce tomate|auvergnate|cuisin/i),
  tuna: M(/\bthon\b/i, ["en:tunas", "en:canned-tunas", "en:canned-albacore-tunas"], /rillette|salade|miettes? sauce|mayonnaise|cuisin|tomate/i),
  olive: M(/\bolives?\b(?! d)/i, ["en:olives", "en:green-olives", "en:black-olives", "en:pitted-olives"], /huile|tapenade|savon/i),
  tofu: M(/\btofu\b/i, ["en:tofu", "en:firm-tofu", "en:tofus"], /saucisse|burger|dessert/i),
  flour: M(/\bfarine\b/i, ["en:wheat-flours", "en:flours", "en:all-purpose-wheat-flours"], /ma[iï]s|sarrasin|riz|pois|gâteau|cr[eê]pes/i),
  yogurt: M(/\byaourts? nature\b/i, ["en:plain-yogurts", "en:natural-yogurts"], /bio.*vanille|fruits/i),
  cucumber: M(/^concombres?\b/i, ["en:cucumbers"], /sauce|tzatziki/i),
  pita: M(/\bpains? pitas?\b/i, ["en:pita-breads", "en:pita"]),
  sausage: M(/\b(saucisses? de toulouse|chipolatas?|saucisses? fra[iî]ches?|merguez)\b/i, ["en:toulouse-sausages", "en:chipolatas", "en:fresh-sausages"], /lentilles|cuisin|cuite/i),
  quinoa: M(/\bquinoa\b/i, ["en:quinoa", "en:white-quinoa"], /galette|boulgour|p[aâ]tes|salade/i),
  mustard: M(/\bmoutarde\b/i, ["en:mustards", "en:dijon-mustards"], /vinaigrette|graines|cornichons/i, true),
  oil: M(/\bhuile d'?\s?olive\b/i, ["en:olive-oils", "en:extra-virgin-olive-oils"], /sardine|thon|maquereau|filets|p[aâ]te/i, true),
  garlic: M(/^ail\b/i, ["en:garlic", "en:garlics"], /saucisson|pur[ée]e|persil|fromage|moulu|semoule|poudre/i),
  curry: M(/\bcurry( en poudre)?\b/i, ["en:curry-powders", "en:curries"], /poulet|p[aâ]te|sauce|riz|cuisin/i),
  bread: M(/\b(baguette|pain de campagne|pain de mie|pain complet)\b/i, ["en:baguettes", "en:sliced-breads", "en:wholemeal-breads"], /brioch|viennois|chocolat|burger/i),
  coffee: M(/\bcaf[ée] (moulu|en grains)\b/i, ["en:ground-coffees", "en:coffee-beans", "en:ground-coffee"], /capsule|dosette/i),
  apple: M(/^pommes?\b(?! de terre)/i, ["en:apples"], /compote|jus|chips|tarte|gourde|rissol|noisettes|duchesse|sautées/i),
  banana: M(/^bananes?\b/i, ["en:bananas"], /chips|sèch|plantain/i),
  leek: M(/\bpoireaux?\b/i, ["en:leeks"], /soupe|fondue|vinaigrette/i),
  cauliflower: M(/\bchoux?[- ]fleurs?\b/i, ["en:cauliflowers"], /gratin|soupe|riz/i),
  "green-bean": M(/\bharicots? verts?\b/i, ["en:green-beans", "en:canned-green-beans", "en:frozen-green-beans"], /poêlée|cuisin/i),
  cabbage: M(/^chou\b(?!-fleur| fleur| de bruxelles| rouge)/i, ["en:cabbages", "en:white-cabbages", "en:green-cabbages"], /farci|choucroute/i),
  beetroot: M(/\bbetteraves?\b/i, ["en:beetroots", "en:cooked-beetroots"], /sucre|chips|jus/i),
  fennel: M(/^fenouils?\b/i, ["en:fennels", "en:fennel", "en:fennel-bulbs"], /graines|tisane|infusion/i),
  turnip: M(/^navets?\b/i, ["en:turnips"]),
  turkey: M(/\b(escalopes?|filets?|blancs?|aiguillettes?) de dinde\b/i, ["en:turkey-cutlets", "en:turkey-escalopes", "en:turkey-breasts"], /fum[ée]|cuit|pan[ée]|tranches/i),
  shrimp: M(/\bcrevettes?\b/i, ["en:shrimps", "en:prawns", "en:peeled-shrimps", "en:cooked-prawns"], /chips|sauce|nems?|samoussa|beignets?|cocktail/i),
  "goat-cheese": M(/\b(fromage de ch[eè]vre|b[uû]che de ch[eè]vre|ch[eè]vre frais)\b/i, ["en:goat-cheeses", "en:fresh-goat-cheeses"]),
  ricotta: M(/\bricotta\b/i, ["en:ricotta", "en:ricottas"], /raviol|tortell|[ée]pinards/i),
  cheddar: M(/\bcheddar\b/i, ["en:cheddars", "en:cheddar-cheeses"], /chips|burger|sauce|biscuit/i),
  parmesan: M(/\b(parmigiano|parmesan|grana padano)\b/i, ["en:parmigiano-reggiano", "en:parmesan", "en:grana-padano"], /sauce|tuiles?|gressins?/i),
  bulgur: M(/\bboulgour\b/i, ["en:bulgur", "en:bulgurs"], /quinoa|salade|cuisin/i),
  "red-bean": M(/\bharicots? rouges?\b/i, ["en:red-beans", "en:red-kidney-beans", "en:canned-red-kidney-beans"], /chili|cuisin/i),
  peanut: M(/\bcacah?u[eè]tes?\b/i, ["en:peanuts", "en:roasted-peanuts"], /beurre|chocolat|m&m|huile|croustilles|pur[ée]e/i),
  almond: M(/\bamandes?\b/i, ["en:almonds", "en:shelled-almonds"], /chocolat|boisson|lait|p[aâ]te|huile|biscuit|gâteau|cr[eè]me|nature|poudre|effil/i),
  walnut: M(/^(cerneaux de )?noix\b(?! de (coco|cajou|muscade|p[eé]can|macadamia|saint))/i, ["en:walnuts", "en:walnut-kernels"], /huile|pain|g[aâ]teau/i),
  sesame: M(/\bgraines? de s[ée]same\b/i, ["en:sesame-seeds"]),
  ginger: M(/^gingembre\b/i, ["en:ginger", "en:gingers"], /confit|bonbon|th[ée]|infusion/i),
  paprika: M(/\bpaprika\b/i, ["en:paprika"], /chips|sauce|poulet/i),
  cumin: M(/\bcumin\b/i, ["en:cumin", "en:cumin-seeds"], /gouda|fromage/i),
  herbs: M(/\bherbes de provence\b/i, ["en:herbes-de-provence", "en:dried-herbs"], /savon|sauce/i),
  parsley: M(/^persil\b/i, ["en:parsley", "en:parsleys"]),
  vinegar: M(/\bvinaigre\b/i, ["en:vinegars", "en:balsamic-vinegars", "en:wine-vinegars"], /m[eé]nager|blanc nettoy|vinaigrette/i, true),
  caper: M(/\bc[aâ]pres?\b/i, ["en:capers"]),
  raisin: M(/\braisins? secs?\b/i, ["en:raisins"], /chocolat/i),
  "dark-chocolate": M(/\bchocolat noir\b/i, ["en:dark-chocolates", "en:dark-chocolate-bars"], /boule|biscuit|fourr|mousse|bonbon|feuillet|c[ée]r[ée]ales|noisettes/i, true),
  "pizza-dough": M(/\bp[aâ]te [àa] pizza\b/i, ["en:pizza-doughs"], null, true),
  "burger-bun": M(/\bpains? (burger|hamburger|[àa] burger|[àa] hamburger)\b/i, ["en:hamburger-buns", "en:burger-buns"], null, true),
};

// Product names decide: Open Food Facts categories are too broad (cornichons under cucumbers), except for
// loose-produce records, where the category is what the contributor selected.
export function matchIngredient(label, tags = [], { trustTags = false } = {}) {
  const text = String(label || "").replace(/\s+/g, " ").trim().replace(/^(?:carrefour(?: classic'?| bio| extra| essential| sensation)?|bio|le|la|les)\s+/i, "");
  if (!text) return null;
  const tagSet = new Set(tags);
  for (const [id, rule] of Object.entries(INGREDIENT_MATCHERS)) {
    if (rule.reject?.test(text)) continue;
    if (!rule.keepMeals && READY_MEAL.test(text)) continue;
    if (trustTags && rule.tags.some((tag) => tagSet.has(tag))) return id;
    const found = rule.name.exec(text); if (!found) continue;
    // A real ingredient leads its label and has no garnish: "Nouilles sautées aux crevettes" is not shrimp.
    const rest = text.slice(0, found.index) + " " + text.slice(found.index + found[0].length);
    if (found.index <= 3 && !COMPOSED.test(rest)) return id;
  }
  return null;
}

// Rejects mismatches: a price far from the ingredient's reference is almost always the wrong product.
export function plausibleUnitPrice(ingredientId, priceCents, quantity) {
  const ingredient = INGREDIENTS[ingredientId]; if (!ingredient || !(quantity > 0) || !(priceCents > 0)) return false;
  const ratio = (priceCents / quantity) / (ingredient.referenceCents / ingredient.referenceQuantity);
  return ratio >= 0.2 && ratio <= 5;
}

const number = (value) => Number(String(value).replace(",", "."));
export function parseQuantity(text) {
  const label = String(text || "").toLowerCase().replace(/\s+/g, " ");
  const total = label.match(/\((\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\)/);
  const multi = label.match(/\b(\d+)\s*(?:x|sachets? de|bo[iî]tes? de|pots? de|barquettes? de|briques? de|tranches? de)\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/);
  const single = label.match(/(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/);
  const convert = (amount, unit) => ({ kg: [amount * 1000, "g"], g: [amount, "g"], l: [amount * 1000, "ml"], cl: [amount * 10, "ml"], ml: [amount, "ml"] })[unit];
  if (total) return convert(number(total[1]), total[2]);
  if (multi) return convert(Number(multi[1]) * number(multi[2]), multi[3]);
  if (single) return convert(number(single[1]), single[2]);
  return null;
}

const cents = (value) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null; };
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const NON_FOOD_SECTION = /whisk|hygi[eè]ne|entretien|pu[ée]ricult|b[ée]b[ée]|mode|boissons/i;
const NON_FOOD_NAME = /whisky|vodka|rhum|\bgin\b|\bvin\b|champagne|bi[eè]res?|purina|aliment pour|chat|chien|couches?|lessive|shampo|dentifrice|d[ée]odorant|papier|essuie|gel douche|rasoir|sacs?|pyjama|chaussettes|collants?|nettoyant/i;

const UNIT_SINGLE = new Set(["pastry", "pizza-dough"]);
const unitCount = (ingredientId, title, packaging) => {
  if (/pi[eè]ce/i.test(packaging)) return 1;
  const counted = `${title} ${packaging}`.match(/(?:^|\s)(\d+)\s*(?:[oœ]ufs|tortillas|pains|wraps)\b/i) || String(packaging).match(/(?:de|x)\s*(\d+)\b(?!\s*(?:[.,]\d+)?\s*(?:g|kg|ml|cl|l)\b)/i);
  return counted ? Number(counted[1]) : UNIT_SINGLE.has(ingredientId) ? 1 : null;
};
// Public rayon pages: national list prices, not a given drive's price (labelled as such in the UI).
export function parseCarrefourCards(html, observedAt) {
  const offers = [];
  for (const match of String(html).matchAll(/<article\b[^>]*class="[^"]*product-list-card-plp-grid[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const card = match[1]; const strip = (value) => clean(String(value || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;|&#160;/g, " "));
    const label = strip(card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]); const packaging = strip(card.match(/<p\b[^>]*class="[^"]*__packaging[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    const price = strip(card.match(/<p\b[^>]*class="[^"]*__shimmer-base-price[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]).match(/^(\d+)[,.](\d{2})\s*€/); const href = card.match(/<a\b[^>]*data-testid="product-card-title"[^>]*href="(\/p\/[a-z0-9-]+)"/i)?.[1];
    if (!label || !price || !href) continue;
    const ingredientId = matchIngredient(label); if (!ingredientId) continue;
    const priceCents = Number(price[1]) * 100 + Number(price[2]); const unit = INGREDIENTS[ingredientId].unit; const loose = /\b(le|au) kilo\b|^le kg$/i.test(packaging);
    let packQuantity = null;
    if (unit === "unit") packQuantity = unitCount(ingredientId, label, packaging);
    else { const quantity = loose ? [1000, "g"] : parseQuantity(packaging); if (quantity?.[1] === unit) packQuantity = quantity[0]; }
    if (!packQuantity || !plausibleUnitPrice(ingredientId, priceCents, packQuantity)) continue;
    offers.push({ id: `carrefour-${href.slice(3)}`.slice(0, 100), storeId: "carrefour", ingredientId, label: label.slice(0, 140), priceCents, packQuantity, unit, loose, packaging: loose ? "au kg" : packaging.slice(0, 80), sourceUrl: `https://www.carrefour.fr${href}`, observedAt, place: "carrefour.fr", source: "carrefour-page", currencyConfirmed: true });
  }
  return offers;
}

// One catalogue line: the unit price is the only comparable price; multi-buy stays a label.
export function parseLeclercProduct(product, operation, now) {
  const priceCents = cents(product.price); const name = clean(product.name); const description = clean(product.description);
  if (!priceCents || !name || name.length < 3) return null;
  const section = clean(product.section);
  if (NON_FOOD_SECTION.test(section) || NON_FOOD_NAME.test(`${name} ${clean(product.brand)}`)) return null;
  if (/^sur les produits/i.test(name)) return null; // Range-wide offers name no single product and no pack.
  const regular = cents(product.priceWithoutDiscount); const conditioning = clean(product.conditioning);
  const multi = description.match(/Par (\d+)(?: \([^)]*\))? ?: ?(\d+[.,]\d{2}) ?€ au lieu de (\d+[.,]\d{2}) ?€/i);
  const percent = regular && regular > priceCents ? Math.round((1 - priceCents / regular) * 100) : multi ? Math.round((1 - number(multi[2]) / number(multi[3])) * 100) : null;
  const loose = /^le kg$/i.test(conditioning);
  const filet = conditioning.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
  // "Calibre 150/180 g" sizes one fruit, not what the price buys.
  const quantity = loose ? [1000, "g"] : /calibre/i.test(description) && !filet ? null : filet ? [number(filet[1]) * 1000, "g"] : parseQuantity(description.split(/Le (?:kg|L) ?:|Par \d/i)[0]);
  const count = name.match(/^(\d+)\s+[oœ]ufs?\b/i);
  const code = operation.code; const uid = clean(product.uid);
  const label = clean(`${name}${product.brand && !name.toUpperCase().includes(String(product.brand).toUpperCase()) ? ` ${product.brand}` : ""}`).slice(0, 140);
  const ingredientId = matchIngredient(name);
  const base = { id: `leclerc-${code}-${uid}`.slice(0, 100), storeId: "leclerc", label, priceCents, regularCents: regular && regular > priceCents ? regular : null, percent: percent > 0 ? percent : null, multiBuy: multi ? { quantity: Number(multi[1]), priceCents: Math.round(number(multi[2]) * 100) } : null, packaging: clean(description.split(/Le (?:kg|L) ?:|Par \d/i)[0]).replace(/\.$/, "").slice(0, 80) || conditioning, startsAt: String(operation.start_date || "").slice(0, 10), endsAt: String(operation.end_date || "").slice(0, 10), catalogue: clean(operation.catch_phrase).slice(0, 100), sourceUrl: `https://nos-catalogues-promos-v2.e.leclerc/catalog/${code}/0100`, observedAt: now, ingredientId, imageUrl: product.images?.find((item) => item.type === "packshot")?.url || product.images?.[0]?.url || "", source: "catalogue" };
  const offer = (() => {
    if (!ingredientId) return null; const unit = INGREDIENTS[ingredientId].unit;
    if (unit === "unit") { const units = count ? Number(count[1]) : null; return units && plausibleUnitPrice(ingredientId, priceCents, units) ? { packQuantity: units, unit } : null; }
    return quantity && quantity[1] === unit && plausibleUnitPrice(ingredientId, priceCents, quantity[0]) ? { packQuantity: quantity[0], unit, loose } : null;
  })();
  return { ...base, offer };
}

export function normalizeOpenPrice(item, now) {
  const location = item?.location; if (!location || location.osm_address_country_code !== "FR" || item.currency !== "EUR") return null;
  const place = clean(location.osm_name); const storeId = /carrefour/i.test(`${place} ${location.osm_brand || ""}`) ? "carrefour" : /leclerc/i.test(`${place} ${location.osm_brand || ""}`) ? "leclerc" : null;
  if (!storeId) return null;
  const priceCents = cents(item.price); if (!priceCents) return null;
  const product = item.product; const label = clean(product?.product_name || item.product_name).slice(0, 140);
  const ingredientId = item.type === "CATEGORY" ? matchIngredient(label, item.category_tag ? [item.category_tag] : [], { trustTags: true }) : matchIngredient(label); if (!ingredientId) return null;
  const unit = INGREDIENTS[ingredientId].unit; let packQuantity; let loose = false;
  if (item.type === "CATEGORY") {
    if (item.price_per === "KILOGRAM" && unit === "g") { packQuantity = 1000; loose = true; }
    else if (item.price_per === "UNIT" && unit === "unit") packQuantity = 1;
    else return null;
  } else {
    const quantity = Number(product?.product_quantity); const measure = String(product?.product_quantity_unit || "").toLowerCase();
    if (!(quantity > 0)) return null;
    const normalized = measure === "g" ? [quantity, "g"] : measure === "ml" ? [quantity, "ml"] : measure === "kg" ? [quantity * 1000, "g"] : measure === "l" ? [quantity * 1000, "ml"] : measure === "cl" ? [quantity * 10, "ml"] : null;
    if (!normalized || normalized[1] !== unit) return null; packQuantity = normalized[0];
  }
  if (!plausibleUnitPrice(ingredientId, priceCents, packQuantity)) return null;
  const city = clean(location.osm_address_city);
  return { id: `op-${item.id}`, storeId, ingredientId, label, priceCents, packQuantity, unit, loose, packaging: loose ? "au kg" : `${packQuantity} ${unit}`, sourceUrl: item.product_code ? `https://prices.openfoodfacts.org/products/${item.product_code}` : `https://prices.openfoodfacts.org/locations/${location.id}`, observedAt: `${item.date}T12:00:00.000Z`, place: city ? `${place}, ${city}` : place, source: "open-prices", currencyConfirmed: true, readAt: now };
}

// Keeps the cheapest few per ingredient and store: enough to choose, small enough for offline storage.
export function keepBestOffers(offers, perStore = 3) {
  const unit = (item) => item.priceCents / item.packQuantity; const sorted = [...offers].sort((a, b) => unit(a) - unit(b)); const seen = new Map(); const kept = []; const labels = new Set();
  for (const item of sorted) { const key = `${item.storeId}:${item.ingredientId}`; const dedupe = `${key}:${item.label}:${item.priceCents}`; if (labels.has(dedupe) || (seen.get(key) || 0) >= perStore) continue; labels.add(dedupe); seen.set(key, (seen.get(key) || 0) + 1); kept.push(item); }
  return kept;
}

// The API refuses non-viewer callers (HTTP 403), so the public page is opened as a visitor would, honest headless
// user agent included; no header is forged and any challenge simply ends the read.
export async function browseLeclercCatalogues(codes) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(); const results = [];
  try {
    for (const code of codes) {
      const page = await browser.newPage({ locale: "fr-FR" }); let operation = null; let products = null; const pending = [];
      page.on("response", (response) => { const url = new URL(response.url()); if (url.hostname !== "nos-catalogues-promos-v2-api.e.leclerc" || !response.ok()) return; if (url.pathname === `/${code}/0100`) pending.push(response.json().then((value) => { operation = value; }).catch(() => {})); else if (/^\/document\/[a-f0-9]+\/products$/.test(url.pathname)) pending.push(response.json().then((value) => { products = value; }).catch(() => {})); });
      const response = await page.goto(`https://nos-catalogues-promos-v2.e.leclerc/catalog/${code}/0100`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => null);
      await Promise.allSettled(pending); await page.close();
      results.push({ code, status: response?.status() ?? null, operation, products: Array.isArray(products) ? products : [] });
    }
  } finally { await browser.close(); }
  return results;
}

const thumbnail = async (url, fetchImpl) => {
  const target = new URL(url); if (target.protocol !== "https:" || target.hostname !== "nos-catalogues-promos-v2.e.leclerc") return "";
  const response = await fetchImpl(target, { signal: AbortSignal.timeout(15000), headers: { "user-agent": USER_AGENT } }); if (!response.ok) return "";
  const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 12 * 1024 * 1024) return "";
  const image = await sharp(buffer).resize(112, 112, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).webp({ quality: 46 }).toBuffer();
  return `data:image/webp;base64,${image.toString("base64")}`;
};

export function rankDeals(deals) { return [...deals].sort((a, b) => Number(Boolean(b.ingredientId)) - Number(Boolean(a.ingredientId)) || (b.percent || 0) - (a.percent || 0) || a.label.localeCompare(b.label, "fr")); }

export class GroceryPriceBook {
  constructor({ file, now = () => Date.now(), fetchImpl = fetch, browse = browseLeclercCatalogues, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pageLimit = 25, carrefourPages = 40, carrefourDelayMs = 3000, maxAgeMs = 12 * 3600000 }) { this.store = new SessionStore(file); this.now = now; this.fetchImpl = fetchImpl; this.browse = browse; this.sleep = sleep; this.pageLimit = pageLimit; this.carrefourPages = carrefourPages; this.carrefourDelayMs = carrefourDelayMs; this.maxAgeMs = maxAgeMs; this.running = null; }
  async load() { await this.store.load(); }
  snapshot() { return { running: Boolean(this.running), ...(this.store.get("book") || { updatedAt: null, products: [], deals: [], stores: [] }) }; }
  stale() { const updatedAt = this.store.get("book")?.updatedAt; return !updatedAt || this.now() - Date.parse(updatedAt) > this.maxAgeMs; }
  refreshIfStale() { if (!this.running && this.stale()) this.refresh().catch(() => {}); }
  refresh() {
    if (this.running) return this.running;
    this.running = this.read().finally(() => { this.running = null; });
    return this.running;
  }
  async json(url) {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(25000), headers: { accept: "application/json", "user-agent": USER_AGENT } });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  async readOpenPrices(iso) {
    const since = new Date(this.now() - 365 * 86400000).toISOString().slice(0, 10); const raw = []; let requests = 0;
    const tags = [...new Set(["en:carrots", "en:potatoes", "en:onions", "en:tomatoes", "en:leeks", "en:zucchini", "en:eggplants", "en:bell-peppers", "en:broccoli", "en:cauliflowers", "en:cabbages", "en:white-cabbages", "en:spinachs", "en:fennel-bulbs", "en:mushrooms", "en:cucumbers", "en:lettuces", "en:green-beans", "en:lemons", "en:apples", "en:bananas", "en:avocados", "en:pumpkins", "en:squashes", "en:sweet-potatoes", "en:garlic", "en:fennels", "en:turnips", "en:beetroots", "en:ginger", "en:parsley"])];
    for (const tag of tags) { const data = await this.json(`${OPEN_PRICES}/prices?category_tag=${encodeURIComponent(tag)}&currency=EUR&date__gte=${since}&size=100&order_by=-date`); raw.push(...(data.items || [])); requests++; await this.sleep(250); }
    const locations = [];
    for (const name of ["Carrefour", "Leclerc"]) { const data = await this.json(`${OPEN_PRICES}/locations?osm_name__like=${name}&size=100&order_by=-price_count`); requests++; const nearby = (data.items || []).filter((item) => item.osm_address_country_code === "FR" && /^(75|78|91|92|93|94|95)/.test(item.osm_address_postcode || "") && item.price_count >= 100); const hypers = nearby.filter((item) => !/market|city|express|contact|montagne/i.test(item.osm_name)); locations.push(...(hypers.length >= 3 ? hypers : nearby).slice(0, 4)); await this.sleep(250); }
    for (const location of locations) for (let page = 1; page <= this.pageLimit; page++) {
      const data = await this.json(`${OPEN_PRICES}/prices?location_id=${location.id}&currency=EUR&date__gte=${since}&size=100&page=${page}&order_by=-date`); requests++; raw.push(...(data.items || [])); await this.sleep(250);
      if (page >= (data.pages || 1)) break;
    }
    const offers = raw.map((item) => normalizeOpenPrice(item, iso)).filter(Boolean);
    return { offers: keepBestOffers(offers), locations: locations.map((item) => `${item.osm_name}, ${item.osm_address_city}`), requests, matched: offers.length, read: raw.length };
  }
  async readCarrefour(iso) {
    const origin = "https://www.carrefour.fr"; const headers = { accept: "text/html", "user-agent": USER_AGENT };
    const robots = await this.fetchImpl(`${origin}/robots.txt`, { signal: AbortSignal.timeout(10000), headers }); const rules = robots.ok ? await robots.text() : null;
    if (rules === null) throw Object.assign(new Error(`robots.txt HTTP ${robots.status}`), { status: robots.status });
    const seeds = ["/r/fruits-et-legumes/legumes", "/r/fruits-et-legumes/fruits", "/r/viandes-et-poissons/boucherie", "/r/viandes-et-poissons/volaille-et-rotisserie", "/r/viandes-et-poissons/poissonnerie", "/r/cremerie", "/r/epicerie-salee", "/r/pains-et-patisseries"];
    const queue = [...seeds]; const seen = new Set(queue); const offers = []; let pages = 0; let blocked = null;
    while (queue.length && pages < this.carrefourPages) {
      const pathname = queue.shift(); if (!robotsAllows(rules, pathname, "NoyauCatalogue")) continue;
      const response = await this.fetchImpl(origin + pathname, { signal: AbortSignal.timeout(20000), redirect: "manual", headers });
      if (response.status === 403 || response.status === 429) { blocked = response.status; break; } // A refusal ends the read; nothing retries around it.
      if (!response.ok) continue;
      const html = await response.text(); pages++; offers.push(...parseCarrefourCards(html, iso));
      for (const match of html.matchAll(/href="(\/r\/[a-z0-9/-]+)"/g)) { const next = match[1]; if (!seen.has(next) && seeds.some((seed) => next.startsWith(`${seed}/`)) && !/aperitif|plats-cuisines|soupes|sauces-chaudes|traiteur/.test(next)) { seen.add(next); queue.push(next); } }
      await this.sleep(this.carrefourDelayMs);
    }
    if (!pages && blocked) throw Object.assign(new Error(`HTTP ${blocked}`), { status: blocked });
    return { offers: keepBestOffers(offers), pages, blocked };
  }
  async readLeclerc(iso) {
    const today = iso.slice(0, 10);
    const response = await this.fetchImpl("https://www.e.leclerc/prospectus?type=001", { signal: AbortSignal.timeout(20000), headers: { accept: "text/html", "user-agent": USER_AGENT } });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const listed = parseLeclercCatalogues(await response.text(), today, { keepVariants: true }); const codes = listed.map((item) => new URL(item.sourceUrl).pathname.split("/")[2]);
    const pages = await this.browse(codes); const deals = new Map(); const offers = []; const read = [];
    for (const page of pages) {
      if (!page.operation || page.operation.is_food === false) continue;
      const end = String(page.operation.end_date || "").slice(0, 10); if (end && end < today) continue;
      const parsed = page.products.map((product) => parseLeclercProduct(product, page.operation, iso)).filter(Boolean); read.push({ code: page.code, title: clean(page.operation.catch_phrase), startsAt: String(page.operation.start_date || "").slice(0, 10), endsAt: end, products: parsed.length });
      for (const item of parsed) {
        const { offer, ...deal } = item; const key = `${deal.label}:${deal.priceCents}`; if (!deals.has(key)) deals.set(key, deal);
        if (offer) offers.push({ ...deal, ...offer, place: `Catalogue ${deal.catalogue}`, currencyConfirmed: true, validFrom: deal.startsAt, validUntil: deal.endsAt });
      }
    }
    if (!read.length) throw new Error(pages.length ? "Aucun catalogue alimentaire lu." : "Aucun catalogue alimentaire en cours.");
    return { deals: rankDeals([...deals.values()]), offers: keepBestOffers(offers), catalogues: read };
  }
  async read() {
    const iso = new Date(this.now()).toISOString(); const previous = this.store.get("book"); const stores = [];
    let leclerc = null; let open = null; let carrefour = null;
    try { carrefour = await this.readCarrefour(iso); stores.push({ storeId: "carrefour", source: "rayons", ok: true, offers: carrefour.offers.length, pages: carrefour.pages, httpStatus: carrefour.blocked }); }
    catch (error) { stores.push({ storeId: "carrefour", source: "rayons", ok: false, httpStatus: error.status || null, error: String(error.message).slice(0, 160) }); }
    try { leclerc = await this.readLeclerc(iso); stores.push({ storeId: "leclerc", source: "catalogue", ok: true, offers: leclerc.deals.length, catalogues: leclerc.catalogues.length }); }
    catch (error) { stores.push({ storeId: "leclerc", source: "catalogue", ok: false, httpStatus: error.status || null, error: String(error.message).slice(0, 160) }); }
    try { open = await this.readOpenPrices(iso); stores.push({ storeId: "all", source: "open-prices", ok: true, offers: open.offers.length, read: open.read, matched: open.matched, locations: open.locations }); }
    catch (error) { stores.push({ storeId: "all", source: "open-prices", ok: false, httpStatus: error.status || null, error: String(error.message).slice(0, 160) }); }
    // A failed source keeps its last good data: stale-but-dated beats an empty comparison.
    const deals = leclerc?.deals || previous?.deals || [];
    const withImages = await this.attachImages(deals.slice(0, 120), previous?.deals || []);
    const products = [...(carrefour?.offers || (previous?.products || []).filter((item) => item.source === "carrefour-page")), ...(leclerc?.offers || (previous?.products || []).filter((item) => item.source === "catalogue")), ...(open?.offers || (previous?.products || []).filter((item) => item.source === "open-prices"))].map(({ imageUrl, ...item }) => item);
    const book = { updatedAt: iso, deals: withImages, products, stores, leclercCatalogues: leclerc?.catalogues || previous?.leclercCatalogues || [] };
    await this.store.set("book", book);
    return book;
  }
  async attachImages(deals, previous) {
    const known = new Map(previous.filter((item) => item.imageData).map((item) => [item.id, item.imageData])); const result = []; let fetched = 0;
    for (const { imageUrl, ...deal } of deals) {
      let imageData = known.get(deal.id) || "";
      if (!imageData && imageUrl && result.length < 60 && fetched < 60) { fetched++; imageData = await thumbnail(imageUrl, this.fetchImpl).catch(() => ""); await this.sleep(100); }
      result.push({ ...deal, imageData });
    }
    return result;
  }
}
