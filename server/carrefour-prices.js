// Public category pages contain list-price cards. They are indicative until the store is selected.
export const CARREFOUR_RAYONS = [
 { url:'https://www.carrefour.fr/r/fruits-et-legumes/legumes/carottes-et-pommes-de-terre/carottes', ingredientId:'carrot', pattern:/\bcarottes?\b/i, reject:/r[aâ]p|jus|baby|pur[eé]e|soupe|pois|cuisin|surgel|bo[iî]te|conserv|julienne/i },
 { url:'https://www.carrefour.fr/r/epicerie-salee/pates', ingredientId:'pasta', pattern:/^p[aâ]tes?\b/i, reject:/sauce|soupe|instant|ramen|yakisoba|cuisin|raviol|gnocchi|sans gluten/i },
 { url:'https://www.carrefour.fr/r/epicerie-salee/pates-riz-feculents', ingredientId:'rice', pattern:/^riz\b/i, reject:/lait|dessert|cuisin|sauce|pouding|g[aâ]teau|micro.?onde|salade/i },
 { url:'https://www.carrefour.fr/r/fruits-et-legumes/legumes/ail-oignons-et-echalotes', rules:[{ingredientId:'onion',pattern:/\boignons?\b/i,reject:/frit|surgel|cuisin|confit|rouge|d[eé]shydrat/i}] },
 { url:'https://www.carrefour.fr/r/fruits-et-legumes/legumes/aubergines-courgettes-et-poivrons', rules:[{ingredientId:'zucchini',pattern:/\bcourgettes?\b/i,reject:/cuisin|r[aâ]p|surgel|fleur|farci|conserv/i},{ingredientId:'aubergine',pattern:/\baubergines?\b/i,reject:/cuisin|surgel|farci|conserv/i},{ingredientId:'pepper',pattern:/\bpoivrons?\b/i,reject:/cuisin|surgel|farci|conserv|piment|marin/i}] },
 { url:'https://www.carrefour.fr/r/fruits-et-legumes/legumes/salades-et-tomates', rules:[{ingredientId:'tomato',pattern:/\btomates?\b/i,reject:/coulis|sauce|s[eé]ch|concentr|conserv|cuisin|salade|cocktail/i}] },
 { url:'https://www.carrefour.fr/r/fruits-et-legumes/legumes/choux-poireaux-navets-et-celeris', rules:[{ingredientId:'leek',pattern:/\bpoireaux?\b/i,reject:/cuisin|surgel|soupe|conserv|[eé]minc/i},{ingredientId:'cabbage',pattern:/\bchou\b/i,reject:/fleur|rouge|bruxelles|surgel|cuisin|conserv|r[aâ]p/i}] },
];
const text = (value) => String(value || '').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
export function weightGrams(input) {
 const label=text(input).toLowerCase().replace(/,/g,'.');
 if (/\b(le|au) kilo\b/.test(label)) return 1000;
 const multi=label.match(/\b(\d+)\s*(?:x|sachets?\s+de)\s*(\d+(?:\.\d+)?)\s*(kg|g)\b/);
 if (multi) return Number(multi[1])*Number(multi[2])*(multi[3]==='kg'?1000:1);
 const match=label.match(/\b(\d+(?:\.\d+)?)\s*(kg|g)\b/);
 return match ? Number(match[1])*(match[2]==='kg'?1000:1) : null;
}
export function parseCarrefourRayon(html, source, observedAt) {
 const category=CARREFOUR_RAYONS.find((item)=>item.url===source); if(!category)return [];
 const rules=category.rules || [category];
 const products=[];
 for(const match of String(html).matchAll(/<article\b[^>]*class="[^"]*product-list-card-plp-grid[^\"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
  const card=match[1], title=text(card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
  const packageText=text(card.match(/<p\b[^>]*class="[^"]*__packaging[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
  const priceText=text(card.match(/<p\b[^>]*class="[^"]*__shimmer-base-price[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
  const href=card.match(/<a\b[^>]*data-testid="product-card-title"[^>]*href="([^"]+)"/i)?.[1];
  const price=priceText.match(/^(\d+)[,.](\d{2})\s*€/), packQuantity=weightGrams(packageText);
  const rule=rules.find((item)=>item.pattern.test(title) && !item.reject.test(title));
  if(!title || !rule || !price || !packQuantity || packQuantity>20000 || !href?.startsWith('/p/'))continue;
  const sourceUrl=new URL(href,'https://www.carrefour.fr');if(sourceUrl.hostname!=='www.carrefour.fr' || !/^\/p\/[a-z0-9-]+$/i.test(sourceUrl.pathname))continue;
  products.push({ingredientId:rule.ingredientId,label:title,packQuantity,unit:'g',packaging:packageText,priceCents:Number(price[1])*100+Number(price[2]),currencyConfirmed:true,sourceUrl:sourceUrl.href,observedAt,source:'carrefour-page'});
 }
 return products.slice(0,30);
}
