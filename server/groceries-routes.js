import express from "express";

export function groceryRoutes({ service, profile }) {
  const router = express.Router();
  router.get("/catalogues", (request, response) => { response.set("Cache-Control", "no-store").json(service.catalogueScan(profile(request))); });
  router.get("/", (request, response) => { const state = service.read(profile(request)); response.set("Cache-Control", "no-store").json(request.query.revision !== undefined && Number(request.query.revision) === state.revision ? { unchanged: true, revision: state.revision } : { state }); });
  router.post("/sync", async (request, response, next) => { try { const result = await service.sync(profile(request), request.body); response.status(result.conflict ? 409 : 200).json(result); } catch (error) { next(error); } });
  router.post("/checkout", (request, response, next) => { try { response.json(service.checkout(profile(request))); } catch (error) { next(error); } });
  return router;
}

export function publicGroceryRoutes(service) {
  const router = express.Router();
  const requests = new Map();
  const origins = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);
  router.use((request, response, next) => {
    const address = request.socket.remoteAddress || "unknown"; const time = Date.now(); let limit = requests.get(address);
    if (!limit || time - limit.start > 60000) { limit = { start: time, count: 0 }; requests.set(address, limit); }
    if (requests.size > 2000) requests.delete(requests.keys().next().value);
    if (++limit.count > 120) return response.status(429).set("Retry-After", "60").json({ error: "Trop de synchronisations. Réessayez dans une minute." });
    const origin = request.get("origin");
    if (origin && !origins.has(origin) && origin !== `https://${request.get("host")}`) return response.status(403).json({ error: "Origine mobile refusée." });
    if (origin) { response.set("Access-Control-Allow-Origin", origin); response.vary("Origin"); response.set("Access-Control-Allow-Headers", "authorization, content-type"); response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); }
    response.set("Cache-Control", "no-store");
    if (request.method === "OPTIONS") return response.sendStatus(204);
    const identity = service.authenticateDevice(String(request.get("authorization") || "").replace(/^Bearer /, ""));
    if (!identity) return response.status(401).json({ error: "Appareil non associé, expiré ou révoqué." });
    request.groceryProfileId = identity.profileId; next();
  });
  // Dedicated public surface excludes checkout and every administrative API.
  router.get("/", (request, response) => { const state = service.read(request.groceryProfileId); response.json(request.query.revision !== undefined && Number(request.query.revision) === state.revision ? { unchanged: true, revision: state.revision } : { state }); });
  router.post("/sync", async (request, response, next) => { try { const result = await service.sync(request.groceryProfileId, request.body); response.status(result.conflict ? 409 : 200).json(result); } catch (error) { next(error); } });
  return router;
}
