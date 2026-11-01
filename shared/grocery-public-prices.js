// Packs are bought whole; loose produce is paid by weight.
const costOf = (line, offer) => {
 if (offer.loose) return { packs: 1, totalCents: Math.ceil(line.needed / offer.packQuantity * offer.priceCents) };
 const packs = Math.ceil(line.needed / offer.packQuantity); return { packs, totalCents: packs * offer.priceCents };
};
export function bestPublicPrices(lines, products) {
 const quotes = Array.isArray(products) ? products : [];
 return lines.filter((line) => line.needed > 0).map((line) => {
  const candidates = quotes.filter((p) => p.ingredientId === line.ingredientId && p.unit === line.unit && Number.isFinite(p.priceCents) && p.priceCents >= 0 && Number.isFinite(p.packQuantity) && p.packQuantity > 0 && /^https:\/\//.test(p.sourceUrl || ""))
   .map((p) => ({ ...p, ...costOf(line, p) }))
   .sort((a, b) => a.totalCents - b.totalCents || a.priceCents / a.packQuantity - b.priceCents / b.packQuantity);
  const byStore = {}; for (const item of candidates) byStore[item.storeId] ||= item;
  return { ingredientId: line.ingredientId, label: line.label, needed: line.needed, unit: line.unit, best: candidates[0] || null, byStore };
 });
}
// Store totals only compare on ingredients priced at every store: a shorter list is not a cheaper basket.
export function comparePublicBasket(lines, products) {
 const rows = bestPublicPrices(lines, products); const priced = rows.filter((row) => row.best);
 const storeIds = [...new Set(priced.flatMap((row) => Object.keys(row.byStore)))];
 const common = priced.filter((row) => storeIds.every((id) => row.byStore[id]));
 const stores = storeIds.map((storeId) => ({ storeId, covered: priced.filter((row) => row.byStore[storeId]).length, totalCents: priced.reduce((sum, row) => sum + (row.byStore[storeId]?.totalCents || 0), 0), commonCents: common.reduce((sum, row) => sum + row.byStore[storeId].totalCents, 0) })).sort((a, b) => a.commonCents - b.commonCents || b.covered - a.covered);
 return { rows, totalLines: rows.length, pricedLines: priced.length, cheapestCents: priced.reduce((sum, row) => sum + row.best.totalCents, 0), missing: rows.filter((row) => !row.best).map((row) => row.label), stores, commonLines: common.length, savingCents: stores.length > 1 && common.length ? Math.max(0, stores.at(-1).commonCents - common.reduce((sum, row) => sum + row.best.totalCents, 0)) : 0 };
}
// Stable for the day, led by what the basket actually needs.
export function dailyDeals(deals, { date, neededIds = new Set(), limit = 10 }) {
 const seed = [...String(date)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
 const mix = (text) => [...String(text)].reduce((sum, char) => (sum * 33 + char.charCodeAt(0)) >>> 0, seed) % 1000;
 const live = (Array.isArray(deals) ? deals : []).filter((deal) => !deal.endsAt || deal.endsAt >= date);
 const score = (deal) => (neededIds.has(deal.ingredientId) ? 5000 : 0) + (deal.ingredientId ? 1500 : 0) + (deal.imageData ? 800 : 0) + (deal.percent || 0) * 20 + mix(deal.id) / 2;
 return [...live].sort((a, b) => score(b) - score(a)).slice(0, limit);
}
