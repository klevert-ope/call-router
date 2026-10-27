type Job = { key: string; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };
export class QueueFull extends Error {}
export class QueueDiscarded extends Error {}

// Preserve order within a call without letting its provider I/O block other calls.
export class SessionQueue {
  private readonly pending: Job[] = [];
  private readonly running = new Set<string>();
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly concurrency = 4, private readonly capacity = 512) {}
  submit(key: string, run: () => Promise<void>): Promise<void> {
    if (this.pending.length + this.running.size >= this.capacity) return Promise.reject(new QueueFull('ARI event queue full'));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ key, run, resolve, reject });
      this.pump();
    });
  }
  idle(): Promise<void> {
    return !this.pending.length && !this.running.size ? Promise.resolve() : new Promise(resolve => { this.waiters.push(resolve); });
  }
  discardPending(): void {
    for (const job of this.pending.splice(0)) job.reject(new QueueDiscarded('ARI event superseded by rescan'));
    this.pump();
  }
  private pump(): void {
    while (this.running.size < this.concurrency) {
      const index = this.pending.findIndex(job => !this.running.has(job.key));
      if (index < 0) break;
      const job = this.pending.splice(index, 1)[0]!;
      this.running.add(job.key);
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.running.delete(job.key);
        this.pump();
      });
    }
    if (!this.pending.length && !this.running.size) for (const resolve of this.waiters.splice(0)) resolve();
  }
}
