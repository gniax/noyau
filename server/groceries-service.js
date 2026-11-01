import crypto from "node:crypto";
import { parseLeclercCatalogues } from "./grocery-catalogues.js";
import { parseCarrefourRayon } from "./carrefour-prices.js";
import { GroceryPriceBook } from "./grocery-price-book.js";
import { dateParis } from "../shared/groceries.js";
import { SessionStore } from "./session-store.js";
import { importRecipe, robotsAllows } from "./recipe-import.js";
import { applyGroceryOperation, compareBaskets, initialGroceries, RETAILERS, shoppingText } from "../shared/groceries.js";

export class GroceriesService {
  constructor({ file, now = () => Date.now(), fetchImpl = fetch, automaticScans = false, priceBook = null }) { this.priceBook = priceBook || (automaticScans ? new GroceryPriceBook({ file: file.replace(/\.json$/, "") + "-prices.json", now }) : null); this.store = new SessionStore(file); this.now = now; this.fetchImpl = fetchImpl; this.automaticScans = automaticScans; this.queues = new Map(); this.catalogueScans = new Map(); this.catalogueWork = Promise.resolve(); }
  async load() {
    await this.store.load(); await this.priceBook?.load();
    // Backfill older personal recipes once, without undoing explicit unfavorites.
    const migrated = [];
    for (const [id, saved] of Object.entries(this.store.all())) {
      if (!saved?.state || !Array.isArray(saved.state.customRecipes)) continue;
      const state = structuredClone(saved.state); state.preferences ||= {};
      const unrated = state.customRecipes.filter((recipe) => recipe?.id && !Object.hasOwn(state.preferences, recipe.id));
      if (!unrated.length) continue;
      for (const recipe of unrated) state.preferences[recipe.id] = "favorite";
      state.revision = (state.revision || 0) + 1; state.updatedAt = new Date(this.now()).toISOString();
      migrated.push([id, { ...saved, state }]);
    }
    if (migrated.length) await this.store.setMany(migrated);
    if (this.automaticScans) {
      const scan = () => { for (const profileId of Object.keys(this.store.all()).filter((id) => id !== "__grocery_sharing__").slice(0, 20)) this.catalogueScan(profileId); };
      const startup = setTimeout(() => { scan(); this.priceBook?.refreshIfStale(); }, 60000); startup.unref(); const timer = setInterval(() => { scan(); this.priceBook?.refreshIfStale(); }, 6 * 3600000); timer.unref();
    }
  }
  ownerOf(profileId) { return this.store.get("__grocery_sharing__")?.members?.[profileId] || profileId; }
  read(profileId) { return structuredClone(this.store.get(this.ownerOf(profileId))?.state || initialGroceries()); }
  async shareProfiles(ownerId, memberId) {
    if (!ownerId || !memberId || ownerId === memberId || this.ownerOf(ownerId) !== ownerId || this.ownerOf(memberId) !== memberId) throw new Error("Partage Courses invalide ou déjà configuré.");
    return this.serialize(ownerId, () => this.serialize(memberId, async () => {
      const owner = this.store.get(ownerId) || { state: initialGroceries(), seen: [], devices: [] };
      const member = this.store.get(memberId); const a = structuredClone(owner.state), b = member?.state;
      if (b) {
        const union = (first, second, key) => [...first, ...second.filter((item) => !first.some((existing) => existing[key] === item[key]))];
        a.customRecipes = union(a.customRecipes || [], b.customRecipes || [], "id");
        a.orders = union(a.orders || [], b.orders || [], "id"); a.shoppingHistory = union(a.shoppingHistory || [], b.shoppingHistory || [], "id"); a.offers = union(a.offers || [], b.offers || [], "id");
        a.extras = union(a.extras || [], b.extras || [], "ingredientId");
        a.pantry = { ...b.pantry, ...a.pantry }; a.preferences = { ...b.preferences, ...a.preferences };
        const used = new Set(a.plan.map((slot) => slot.id));
        for (const slot of b.plan || []) { if (a.plan.some((item) => item.id === slot.id && item.recipeId === slot.recipeId && item.status === slot.status)) continue; let id = slot.id; let suffix = 1; while (used.has(id)) id = `${slot.id}-shared-${suffix++}`; used.add(id); a.plan.push({ ...slot, id }); }
        a.revision = Math.max(a.revision || 0, b.revision || 0);
      }
      a.revision++; a.updatedAt = new Date(this.now()).toISOString();
      const sharing = this.store.get("__grocery_sharing__") || { members: {} };
      const shared = { ...sharing, members: { ...sharing.members, [memberId]: ownerId } };
      await this.store.setMany([[ownerId, { ...owner, state: a, seen: [...new Set([...(owner.seen || []), ...(member?.seen || [])])].slice(-5000) }], ["__grocery_sharing__", shared]]);
      return { ownerId, memberId };
    }));
  }
  serialize(profileId, operation) {
    const previous = this.queues.get(profileId) || Promise.resolve();
    const work = previous.catch(() => {}).then(operation); const tail = work.catch(() => {}); this.queues.set(profileId, tail);
    tail.then(() => { if (this.queues.get(profileId) === tail) this.queues.delete(profileId); }); return work;
  }
  async sync(profileId, { baseRevision, operations } = {}) {
    const requestedProfileId = profileId; profileId = this.ownerOf(profileId);
    if (!Array.isArray(operations) || operations.length > 200 || !Number.isSafeInteger(baseRevision)) throw new Error("Lot de synchronisation invalide (200 actions maximum).");
    return this.serialize(profileId, async () => {
      if (this.ownerOf(requestedProfileId) !== profileId) return this.sync(requestedProfileId, { baseRevision, operations });
      const saved = this.store.get(profileId) || { state: initialGroceries(), seen: [], devices: [] };
      const ids = new Set(saved.seen);
      if (operations.some((operation) => !operation || typeof operation.id !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(operation.id))) throw new Error("Identifiant d'action invalide.");
      const unseen = operations.filter((operation) => !ids.has(operation.id));
      if (unseen.length && saved.state.revision !== baseRevision) return { conflict: true, state: structuredClone(saved.state) };
      let state = structuredClone(saved.state);
      for (const operation of unseen) {
        if (ids.has(operation.id)) continue;
        try { state = applyGroceryOperation(state, operation); }
        catch (error) { return { invalid: true, operationId: operation.id, error: String(error?.message || "Action invalide.").slice(0, 250), state: structuredClone(saved.state) }; }
        state.revision++; ids.add(operation.id);
      }
      if (unseen.length) { state.updatedAt = new Date(this.now()).toISOString(); await this.store.set(profileId, { ...saved, state, seen: [...ids].slice(-5000) }); }
      return { state, accepted: operations.map((operation) => operation.id) };
    });
  }
  async addDevice(profileId, name = "Application Noyau") {
    return this.serialize(profileId, async () => {
      const saved = this.store.get(profileId) || { state: initialGroceries(), seen: [], devices: [] };
      const token = crypto.randomBytes(32).toString("base64url");
      const device = { id: crypto.randomUUID(), name: String(name).slice(0, 80), hash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: this.now() + 90 * 86400000, createdAt: this.now() };
      await this.store.set(profileId, { ...saved, devices: [...saved.devices, device].slice(-10) });
      return { id: device.id, token, expiresAt: device.expiresAt, scope: "groceries.sync" };
    });
  }
  devices(profileId) { return (this.store.get(profileId)?.devices || []).map(({ hash, ...device }) => device); }
  async revokeDevice(profileId, id) { return this.serialize(profileId, async () => { const saved = this.store.get(profileId); if (saved) await this.store.set(profileId, { ...saved, devices: saved.devices.filter((device) => device.id !== id) }); }); }
  authenticateDevice(token) {
    if (typeof token !== "string" || token.length > 200) return null;
    const hash = crypto.createHash("sha256").update(token).digest();
    for (const [profileId, saved] of Object.entries(this.store.all())) for (const device of saved.devices || []) {
      if (device.expiresAt > this.now() && crypto.timingSafeEqual(hash, Buffer.from(device.hash, "hex"))) return { profileId, deviceId: device.id };
    }
    return null;
  }
  async importRecipe(url) { return importRecipe(url, this.fetchImpl === fetch ? {} : { fetchImpl: this.fetchImpl }); }
  async publicProduct(url, storeId, { respectRobots = false } = {}) {
    const hosts = { carrefour: ["carrefour.fr"], leclerc: ["leclercdrive.fr", "e.leclerc"], picnic: ["picnic.app"] };
    const allowed = (value) => { const target = new URL(value); if (target.protocol !== "https:" || target.username || target.password || target.port && target.port !== "443" || !hosts[storeId]?.some((host) => target.hostname === host || target.hostname.endsWith(`.${host}`))) throw new Error("URL officielle de l'enseigne requise."); return target; };
    let target = allowed(url); let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (respectRobots) {
        const robots = await this.fetchImpl(new URL("/robots.txt", target), { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "user-agent": "NoyauCatalogue/1.0" } });
        if (!robots.ok || !robots.body) throw new Error("Règles du site inaccessibles.");
        const reader = robots.body.getReader(); let size = 0; const chunks = [];
        try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 262144) throw new Error("Règles du site trop volumineuses."); chunks.push(Buffer.from(value)); } } finally { await reader.cancel(); }
        if (!robotsAllows(Buffer.concat(chunks).toString("utf8"), target.pathname + target.search, "NoyauCatalogue")) throw new Error("Consultation automatique interdite par le site.");
      }
      response = await this.fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { accept: "text/html,application/ld+json", ...(respectRobots ? { "user-agent": "NoyauCatalogue/1.0" } : {}) } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { target = allowed(new URL(response.headers.get("location"), target).href); continue; }
      break;
    }
    if (!response?.ok) throw Object.assign(new Error(`Accès refusé par le site (HTTP ${response?.status ?? "?"}).`), { status: response?.status });
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) throw new Error("Page trop volumineuse."); chunks.push(Buffer.from(value)); } } finally { await reader.cancel(); }
    const html = Buffer.concat(chunks).toString("utf8"); const products = [];
    const visit = (value) => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) return value.forEach(visit); if ([value["@type"]].flat().includes("Product")) { const offer = [value.offers].flat().find((item) => item && Number.isFinite(Number(item.price)) && (item.priceCurrency === "EUR" || !item.priceCurrency)); if (offer) products.push({ label: String(value.name || "Produit").slice(0, 200), priceCents: Math.round(Number(offer.price) * 100), currencyConfirmed: offer.priceCurrency === "EUR", sourceUrl: target.href, observedAt: new Date(this.now()).toISOString(), source: "Donnée structurée publique — magasin et conditionnement à confirmer" }); } for (const child of Object.values(value)) if (typeof child === "object") visit(child); };
    for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { visit(JSON.parse(match[1])); } catch { /* unrelated structured data */ } }
    if (storeId === "carrefour") products.push(...parseCarrefourRayon(html, target.href, new Date(this.now()).toISOString()));
    const catalogues = storeId === "leclerc" && target.pathname === "/prospectus" ? parseLeclercCatalogues(html, dateParis(new Date(this.now()))) : [];
    if (!products.length && !catalogues.length) throw new Error("Aucun prix lisible sur cette page.");
    return { products: products.slice(0, 50), catalogues, fetchedAt: new Date(this.now()).toISOString() };
  }
  // Profile scan (rayons, tracked pages) merged with the shared price book, which survives restarts.
  publicPrices(profileId) {
    this.priceBook?.refreshIfStale();
    const scan = this.catalogueScan(profileId); const book = this.priceBook?.snapshot() || { running: false, updatedAt: null, products: [], deals: [], stores: [] };
    return { ...scan, running: scan.running || book.running, products: [...scan.products, ...book.products], deals: book.deals, bookStores: book.stores, bookUpdatedAt: book.updatedAt };
  }
  catalogueScan(profileId, { force = false } = {}) {
    profileId = this.ownerOf(profileId);
    const previous = this.catalogueScans.get(profileId); const time = this.now();
    if (previous?.running || !force && previous && time - previous.startedAt < 6 * 3600000) return previous;
    const result = { running: true, startedAt: time, completedAt: null, sources: [], products: [], catalogues: [] }; this.catalogueScans.set(profileId, result);
    const state = this.read(profileId); const stores = new Set(state.stores.filter((item) => item.enabled).map((item) => item.id));
    // Picnic publishes no price page: its prices exist only behind the app login.
    const sources = RETAILERS.filter((item) => stores.has(item.id) && item.id !== "picnic").map((item) => ({ storeId: item.id, url: item.leaflet, kind: "catalogue" }));
    for (const offer of state.offers.filter((item) => stores.has(item.storeId))) if (sources.length < 23 && !sources.some((item) => item.storeId === offer.storeId && item.url === offer.sourceUrl)) sources.push({ storeId: offer.storeId, url: offer.sourceUrl, kind: "produit" });
    const work = this.catalogueWork.catch(() => {}).then(async () => {
      const rateLimited = new Set();
      for (const source of sources) {
        if (rateLimited.has(source.storeId)) continue;
        try {
          const data = await this.publicProduct(source.url, source.storeId, { respectRobots: true });
          const products = data.products.filter((item) => item.currencyConfirmed && item.priceCents >= 0 && item.priceCents <= 1000000);
          for (const item of products) if (result.products.length < 250 && !result.products.some((existing) => existing.storeId === source.storeId && existing.sourceUrl === item.sourceUrl && existing.label === item.label)) result.products.push({ ...item, storeId: source.storeId });
          for (const item of data.catalogues || []) result.catalogues.push({ ...item, storeId: source.storeId });
          result.sources.push({ storeId: source.storeId, url: source.url, kind: source.kind, status: products.length ? `${products.length} prix lus` : data.catalogues?.length ? `${data.catalogues.length} catalogues lus` : "aucun prix en euros" });
        } catch (error) { if (error.status === 429 || error.status === 403) rateLimited.add(source.storeId); result.sources.push({ storeId: source.storeId, url: source.url, kind: source.kind, httpStatus: error.status || null, status: String(error.message || "Source inaccessible").slice(0, 180) }); }
      }
      result.running = false; result.completedAt = new Date(this.now()).toISOString();
    });
    this.catalogueWork = work.catch(() => { result.running = false; result.completedAt = new Date(this.now()).toISOString(); });
    return result;
  }
  checkout(profileId) {
    const state = this.read(profileId); const comparison = compareBaskets(state, new Date(this.now()).toISOString());
    if (!comparison.best) throw new Error("Panier incomplet, minimum non atteint ou conditions magasin non confirmées.");
    return { ...comparison.best, carts: comparison.best.carts.map((cart) => ({ ...cart, retailer: RETAILERS.find((item) => item.id === cart.id) })), text: shoppingText(state, comparison), status: "draft", orderCreated: false, message: "Transfert assisté : aucun accès partenaire aux paniers des enseignes, aucune commande ni paiement effectués." };
  }
}
