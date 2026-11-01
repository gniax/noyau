import test from 'node:test'; import assert from 'node:assert/strict';
import { parseLeclercCatalogues } from '../server/grocery-catalogues.js';
test('official catalogues include only current safe links and dates', () => {
 const html = `<button data-operation-code="A" href="https://nos-catalogues-promos-v2.e.leclerc/catalog/26G310E/0100" aria-label="Afficher le catalogue Pouvoir d'achat Du 27 oct. au 07 nov. 2026"></button><button data-operation-code="B" href="https://evil.test/catalog/A/B" aria-label="Afficher le catalogue Promo Du 27 oct. au 07 nov. 2026"></button>`;
 assert.equal(parseLeclercCatalogues(html,'2026-11-01').length,1);
 assert.equal(parseLeclercCatalogues(html,'2026-11-08').length,0);
});
