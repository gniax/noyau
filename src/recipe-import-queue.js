// The server owns the durable work; this client only polls while visible.
export class RecipeImportQueue {
  constructor(request, { pollMs = 2500 } = {}) { this.request=request; this.pollMs=pollMs; this.remote=[]; this.local=[]; this.listeners=new Set(); this.nextId=0; this.timer=null; this.refreshing=null; this.refreshAgain=false; this.cancelled=new Set(); }
  snapshot() { return [...this.remote, ...this.local].map(item=>({...item})); }
  publish() { const snapshot=this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
  subscribe(listener) {
    this.listeners.add(listener); listener(this.snapshot()); this.refresh().catch(()=>{});
    if (!this.timer) this.timer=setInterval(()=>this.refresh().catch(()=>{}),this.pollMs);
    return () => { this.listeners.delete(listener); if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer=null; } };
  }
  async refresh() {
    if (this.refreshing) { this.refreshAgain=true; return this.refreshing; }
    this.refreshing=(async()=>{ const data=await this.request('/api/groceries/import-jobs'); this.remote=Array.isArray(data.jobs)?data.jobs:[]; this.publish(); })();
    try { await this.refreshing; } finally { this.refreshing=null; if (this.refreshAgain) { this.refreshAgain=false; this.refresh().catch(()=>{}); } }
  }
  enqueue(url) {
    const id=`local-${Date.now()}-${++this.nextId}`; this.local.push({id,url,status:'submitting',local:true,error:null}); this.publish();
    (async()=>{try { const data=await this.request('/api/groceries/import-jobs',{method:'POST',body:JSON.stringify({url})});
      this.local=this.local.filter(item=>item.id!==id);
      if (this.cancelled.delete(id)) await this.request(`/api/groceries/import-jobs/${encodeURIComponent(data.job.id)}`,{method:'DELETE'});
      else { this.remote=[...this.remote.filter(item=>item.id!==data.job.id),data.job]; await this.refresh(); }
    } catch(error) { const item=this.local.find(entry=>entry.id===id); if(item){item.status='error';item.error=error?.message || 'Import impossible.';} } finally {this.publish();} })();
    return id;
  }
  async result(id) { const data=await this.request(`/api/groceries/import-jobs/${encodeURIComponent(id)}`); if (!data.job?.result) throw new Error('Recette pas encore disponible.'); return data.job.result; }
  async remove(id) {
    const local=this.local.find(item=>item.id===id);
    if (local) { this.local=this.local.filter(item=>item.id!==id); if (local.status!=='error') this.cancelled.add(id); this.publish(); return; }
    await this.request(`/api/groceries/import-jobs/${encodeURIComponent(id)}`,{method:'DELETE'}); this.remote=this.remote.filter(item=>item.id!==id); this.publish();
  }
  async retry(id) {
    const item=this.local.find(entry=>entry.id===id);
    if (item) { this.local=this.local.filter(entry=>entry.id!==id); this.enqueue(item.url); return; }
    await this.request(`/api/groceries/import-jobs/${encodeURIComponent(id)}/retry`,{method:'POST',body:'{}'}); await this.refresh();
  }
}
const queues=new Map();
export function recipeImportQueue(key,request) { if(!queues.has(key))queues.set(key,new RecipeImportQueue(request));return queues.get(key); }
