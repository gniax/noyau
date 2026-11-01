import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecipeImportJobs } from '../server/recipe-import-jobs.js';
import { SessionStore } from '../server/session-store.js';
const wait=async(check)=>{for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');};
async function fixture(t,importer){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'noyau-import-jobs-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const jobs=new RecipeImportJobs({file:path.join(dir,'jobs.json'),importer});await jobs.load();return jobs;}

test('server continues sequential imports with no connected client and isolates profiles',async(t)=>{
 let finishFirst;const calls=[];
 const jobs=await fixture(t,url=>{calls.push(url);if(calls.length===1)return new Promise(resolve=>{finishFirst=resolve;});return Promise.resolve({title:'Second',imageData:'secret-image'});});
 const a=await jobs.enqueue('alice','https://example.com/one');const b=await jobs.enqueue('alice','https://example.com/two');
 await wait(()=>typeof finishFirst==='function');assert.equal(calls.length,1);assert.deepEqual(jobs.list('bob'),[]);
 finishFirst({title:'First'});await wait(()=>jobs.get('alice',b.id)?.status==='ready');
 assert.deepEqual(calls,['https://example.com/one','https://example.com/two']);assert.equal(jobs.get('alice',a.id).result.title,'First');
 assert.equal(jobs.list('alice')[1].title,'Second');assert.equal('result' in jobs.list('alice')[1],false);
});
test('interrupted jobs restart and deleted running jobs do not return',async(t)=>{
 let finish;const jobs=await fixture(t,()=>new Promise(resolve=>{finish=resolve;}));const item=await jobs.enqueue('p','https://example.com/a');await wait(()=>typeof finish==='function');
 await jobs.remove('p',item.id);finish({title:'Gone'});await wait(()=>!jobs.running);assert.equal(jobs.get('p',item.id),null);
 const store=new SessionStore(jobs.store.file);await store.load();await store.set('p',{jobs:[{id:'recover-id',url:'https://example.com/recover',status:'loading',result:null}]});
 const recovered=new RecipeImportJobs({file:jobs.store.file,importer:async()=>({title:'Recovered'})});await recovered.load();await wait(()=>recovered.get('p','recover-id')?.status==='ready');
 assert.equal(recovered.get('p','recover-id').result.title,'Recovered');
});
test('jobs reject private URLs and retry failures explicitly',async(t)=>{
 let attempts=0;const jobs=await fixture(t,async()=>{if(++attempts===1)throw Error('Unavailable');return {title:'Ready'};});
 await assert.rejects(jobs.enqueue('p','https://127.0.0.1/private'),/public/);
 const item=await jobs.enqueue('p','https://example.com');await wait(()=>jobs.get('p',item.id)?.status==='error');
 assert.equal(await jobs.retry('other',item.id),false);assert.equal(await jobs.retry('p',item.id),true);await wait(()=>jobs.get('p',item.id)?.status==='ready');
});
