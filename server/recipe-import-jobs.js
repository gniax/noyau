import crypto from 'node:crypto';
import { SessionStore } from './session-store.js';
import { publicTarget } from './public-url-fetch.js';

// Durable, profile-scoped work. The server, not the foreground WebView, advances
// the queue; interrupted jobs are retried after a server restart.
export class RecipeImportJobs {
  constructor({ file, importer, now = () => Date.now() }) { this.store = new SessionStore(file); this.importer = importer; this.now = now; this.lock = Promise.resolve(); this.running = false; }
  async load() {
    await this.store.load(); const updates = [];
    for (const [profile, saved] of Object.entries(this.store.all())) {
      if (!Array.isArray(saved?.jobs)) continue;
      const jobs = saved.jobs.map((job) => job.status === 'loading' ? { ...job, status:'queued' } : job);
      updates.push([profile, { ...saved, jobs }]);
    }
    if (updates.length) await this.store.setMany(updates);
    this.kick();
  }
  serial(action) { const work = this.lock.catch(() => {}).then(action); this.lock = work.catch(() => {}); return work; }
  list(profile) { return (this.store.get(profile)?.jobs || []).map(({ result, ...job }) => ({ ...job, title: result?.title || null })); }
  get(profile, id) { const item = (this.store.get(profile)?.jobs || []).find(job => job.id === id); return item ? structuredClone(item) : null; }
  async enqueue(profile, value) {
    const url = publicTarget(value).href;
    const item = await this.serial(async () => {
      const saved = this.store.get(profile) || { jobs:[] }; if (saved.jobs.length >= 20) throw new Error('Maximum 20 imports : retirez ou enregistrez les anciens.');
      const job = { id:crypto.randomUUID(), url, status:'queued', createdAt:new Date(this.now()).toISOString(), error:null, result:null };
      await this.store.set(profile,{ ...saved, jobs:[...saved.jobs,job] }); return job;
    }); this.kick(); return { ...item, result:undefined };
  }
  async remove(profile, id) { return this.serial(async () => { const saved=this.store.get(profile); if (!saved || !saved.jobs.some(job=>job.id===id)) return false; await this.store.set(profile,{...saved,jobs:saved.jobs.filter(job=>job.id!==id)}); return true; }); }
  async retry(profile, id) {
    const changed=await this.serial(async()=>{const saved=this.store.get(profile);const job=saved?.jobs.find(item=>item.id===id);if(!job || job.status!=='error') return false;await this.store.set(profile,{...saved,jobs:saved.jobs.map(item=>item.id===id?{...item,status:'queued',error:null}:item)});return true;}); if(changed)this.kick();return changed;
  }
  kick() { if (this.running) return; this.running=true; this.run().catch(() => {}).finally(() => { this.running=false; if (Object.values(this.store.all()).some(saved => saved?.jobs?.some(job => job.status==='queued'))) this.kick(); }); }
  async run() {
    while (true) {
      const selected=await this.serial(async()=>{for(const [profile,saved] of Object.entries(this.store.all())) {const job=saved?.jobs?.find(item=>item.status==='queued');if(!job)continue;await this.store.set(profile,{...saved,jobs:saved.jobs.map(item=>item.id===job.id?{...item,status:'loading'}:item)});return {profile,job};}return null;});
      if(!selected)return;
      let result=null,error=null;try { result=await this.importer(selected.job.url); } catch(reason) { error=String(reason?.message || 'Import impossible.').slice(0,250); }
      await this.serial(async()=>{const saved=this.store.get(selected.profile);if(!saved?.jobs.some(job=>job.id===selected.job.id))return;await this.store.set(selected.profile,{...saved,jobs:saved.jobs.map(job=>job.id===selected.job.id?{...job,status:error?'error':'ready',result,error}:job)});});
    }
  }
}
