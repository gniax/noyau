import test from 'node:test';
import assert from 'node:assert/strict';
import { RecipeImportQueue } from '../src/recipe-import-queue.js';
const wait=async(check)=>{for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');};
function fakeServer(){
 let jobs=[];let counter=0;
 const request=async(path,options={})=>{
  if(path==='/api/groceries/import-jobs'&&options.method==='POST'){const item={id:`server-${++counter}`,url:JSON.parse(options.body).url,status:'queued'};jobs.push(item);return {job:{...item}};}
  if(path==='/api/groceries/import-jobs')return {jobs:jobs.map(({result,...item})=>({...item,title:result?.title}))};
  const match=path.match(/import-jobs\/([^/]+)(\/retry)?$/);const item=jobs.find(x=>x.id===match?.[1]);
  if(options.method==='DELETE'){jobs=jobs.filter(x=>x.id!==match[1]);return {};}
  if(match?.[2]){item.status='queued';return {ok:true};}
  return {job:item};
 };
 return {request,jobs:()=>jobs};
}
test('queued work is server-owned and visible after returning to the screen',async()=>{
 const server=fakeServer(),client=new RecipeImportQueue(server.request,{pollMs:10000});let seen=[];const unsub=client.subscribe(items=>{seen=items;});
 client.enqueue('https://example.com/one');client.enqueue('https://example.com/two');await wait(()=>server.jobs().length===2);unsub();
 server.jobs()[0].status='ready';server.jobs()[0].result={title:'First'};server.jobs()[1].status='ready';server.jobs()[1].result={title:'Second'};
 const unsubAgain=client.subscribe(items=>{seen=items;});await wait(()=>seen.filter(x=>x.status==='ready').length===2);
 assert.equal((await client.result('server-1')).title,'First');await client.remove('server-1');assert.equal(server.jobs().length,1);unsubAgain();
});
test('failed server jobs can be retried without affecting others',async()=>{
 const server=fakeServer(),client=new RecipeImportQueue(server.request,{pollMs:10000});const unsub=client.subscribe(()=>{});
 client.enqueue('https://example.com');await wait(()=>server.jobs().length===1);server.jobs()[0].status='error';await client.refresh();
 await client.retry('server-1');assert.equal(server.jobs()[0].status,'queued');unsub();
});
