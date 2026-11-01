import crypto from "node:crypto";

// Browsers allow 6 connections per host: a slow LLM call must never hold one.
export class AiJobs {
  constructor({ concurrency = 2, patienceMs = 120, maxJobs = 400, finishedTtlMs = 5 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { concurrency, patienceMs, maxJobs, finishedTtlMs, now });
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
  }

  static key(...parts) {
    return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.running += 1;
      Promise.resolve().then(job.work).then((value) => { job.value = value; }, (error) => { job.error = error; }).finally(() => {
        job.done = true;
        job.doneAt = this.now();
        this.running -= 1;
        job.resolve();
        this.pump();
      });
    }
  }

  purge() {
    const now = this.now();
    for (const [key, job] of this.jobs) if (job.done && now - job.doneAt > this.finishedTtlMs) this.jobs.delete(key);
    while (this.jobs.size > this.maxJobs) {
      const oldest = [...this.jobs].find(([, job]) => job.done || this.queue.includes(job));
      if (!oldest) break;
      this.jobs.delete(oldest[0]);
      this.queue = this.queue.filter((job) => job !== oldest[1]);
      oldest[1].resolve();
    }
  }

  // Finished results are handed out once: callers keep their own durable cache.
  async run(key, work) {
    let job = this.jobs.get(key);
    if (!job) {
      this.purge();
      job = { work, done: false };
      job.finished = new Promise((resolve) => { job.resolve = resolve; });
      this.jobs.set(key, job);
      this.queue.push(job);
      this.pump();
    }
    if (!job.done) await Promise.race([job.finished, new Promise((resolve) => { setTimeout(resolve, this.patienceMs); })]);
    if (!job.done) return { pending: true };
    this.jobs.delete(key);
    if (job.error) throw job.error;
    return job.value;
  }
}
