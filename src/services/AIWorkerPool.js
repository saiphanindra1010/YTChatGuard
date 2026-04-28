/**
 * Bounded async worker pool with a priority queue.
 *
 * - `submit(item, priority)` enqueues; lower `priority` value runs sooner.
 * - At most `concurrency` jobs run in parallel — eliminates head-of-line
 *   blocking that a single-flight processor suffers from.
 * - Items beyond `maxQueueDepth` are rejected so callers can fall back
 *   to a rules-only verdict (backpressure).
 *
 * The heap is a textbook binary min-heap on the `priority` field plus a
 * monotonically-increasing sequence number to break ties (FIFO within the
 * same priority class).
 */

class PriorityHeap {
  constructor() {
    this.data = [];
    this.seq = 0;
  }

  size() {
    return this.data.length;
  }

  push(priority, item) {
    const node = { priority, seq: this.seq++, item };
    this.data.push(node);
    this._siftUp(this.data.length - 1);
  }

  pop() {
    const data = this.data;
    if (data.length === 0) return null;
    const top = data[0];
    const last = data.pop();
    if (data.length > 0) {
      data[0] = last;
      this._siftDown(0);
    }
    return top.item;
  }

  _less(a, b) {
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.seq < b.seq;
  }

  _siftUp(i) {
    const data = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._less(data[i], data[parent])) {
        [data[i], data[parent]] = [data[parent], data[i]];
        i = parent;
      } else break;
    }
  }

  _siftDown(i) {
    const data = this.data;
    const n = data.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this._less(data[l], data[best])) best = l;
      if (r < n && this._less(data[r], data[best])) best = r;
      if (best === i) break;
      [data[i], data[best]] = [data[best], data[i]];
      i = best;
    }
  }
}

class AIWorkerPool {
  /**
   * @param {object} opts
   * @param {number} [opts.concurrency=4]   max in-flight jobs
   * @param {number} [opts.maxQueueDepth=200] backpressure cap
   * @param {(item:any)=>Promise<any>} opts.handler  job handler
   */
  constructor({ concurrency = 4, maxQueueDepth = 200, handler }) {
    if (typeof handler !== 'function') {
      throw new Error('AIWorkerPool: handler is required');
    }
    this.concurrency = Math.max(1, concurrency | 0);
    this.maxQueueDepth = Math.max(1, maxQueueDepth | 0);
    this.handler = handler;
    this.queue = new PriorityHeap();
    this.inflight = 0;
    this._draining = false;
    this._stopped = false;
  }

  /**
   * Returns true if the item was accepted, false if dropped due to backpressure.
   */
  submit(item, priority = 5) {
    if (this._stopped) return false;
    if (this.queue.size() >= this.maxQueueDepth) return false;
    this.queue.push(priority, item);
    this._drain();
    return true;
  }

  size() {
    return this.queue.size();
  }

  inflightCount() {
    return this.inflight;
  }

  async drainAndStop() {
    this._stopped = true;
    while (this.queue.size() > 0 || this.inflight > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  _drain() {
    if (this._draining) return;
    this._draining = true;
    while (this.inflight < this.concurrency && this.queue.size() > 0) {
      const item = this.queue.pop();
      this.inflight++;
      Promise.resolve()
        .then(() => this.handler(item))
        .catch((err) => {
          console.error('AIWorkerPool handler error:', err && err.message);
        })
        .finally(() => {
          this.inflight--;
          this._drain();
        });
    }
    this._draining = false;
  }
}

module.exports = { AIWorkerPool, PriorityHeap };
