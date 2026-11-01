import test from 'node:test'; import assert from 'node:assert/strict'; import { cachedProjectImage } from '../src/project-image-cache.js';
test('versioned images are cached separately for each profile', async () => {
 const stores = new Map(); const storage = { open: async n => { if (!stores.has(n)) stores.set(n,new Map()); let store=stores.get(n); return {match:async k=>store.get(k)?.clone(),put:async(k,v)=>store.set(k,v)}; }}; let count=0;
 const fetchImpl=async()=>{count++;return new Response(new Blob(['img'],{type:'image/png'}));};
 for(const scope of ['a','a','b']) await cachedProjectImage('/api/projects/1/logo?v=1',scope,{storage,fetchImpl});
 assert.equal(count,2); await cachedProjectImage('/api/projects/1/logo?v=2','a',{storage,fetchImpl}); assert.equal(count,3);
});
