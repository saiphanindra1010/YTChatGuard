"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIWorkerPool = exports.PriorityHeap = void 0;
class PriorityHeap {
    data = [];
    seq = 0;
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
        if (data.length === 0)
            return null;
        const top = data[0];
        const last = data.pop();
        if (last && data.length > 0) {
            data[0] = last;
            this._siftDown(0);
        }
        return top.item;
    }
    _less(a, b) {
        if (a.priority !== b.priority)
            return a.priority < b.priority;
        return a.seq < b.seq;
    }
    _siftUp(i) {
        const data = this.data;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._less(data[i], data[parent])) {
                [data[i], data[parent]] = [data[parent], data[i]];
                i = parent;
            }
            else
                break;
        }
    }
    _siftDown(i) {
        const data = this.data;
        const n = data.length;
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let best = i;
            if (l < n && this._less(data[l], data[best]))
                best = l;
            if (r < n && this._less(data[r], data[best]))
                best = r;
            if (best === i)
                break;
            [data[i], data[best]] = [data[best], data[i]];
            i = best;
        }
    }
}
exports.PriorityHeap = PriorityHeap;
class AIWorkerPool {
    concurrency;
    maxQueueDepth;
    handler;
    queue = new PriorityHeap();
    _inflight = 0;
    _draining = false;
    _stopped = false;
    constructor(options) {
        const { concurrency = 4, maxQueueDepth = 200, handler } = options;
        if (typeof handler !== 'function') {
            throw new Error('AIWorkerPool: handler is required');
        }
        this.concurrency = Math.max(1, concurrency | 0);
        this.maxQueueDepth = Math.max(1, maxQueueDepth | 0);
        this.handler = handler;
    }
    /** Returns true if the item was accepted, false if dropped due to backpressure. */
    submit(item, priority = 5) {
        if (this._stopped)
            return false;
        if (this.queue.size() >= this.maxQueueDepth)
            return false;
        this.queue.push(priority, item);
        this._drain();
        return true;
    }
    size() {
        return this.queue.size();
    }
    inflightCount() {
        return this._inflight;
    }
    async drainAndStop() {
        this._stopped = true;
        while (this.queue.size() > 0 || this._inflight > 0) {
            await new Promise((r) => setTimeout(r, 25));
        }
    }
    _drain() {
        if (this._draining)
            return;
        this._draining = true;
        while (this._inflight < this.concurrency && this.queue.size() > 0) {
            const item = this.queue.pop();
            if (item == null)
                break;
            this._inflight++;
            Promise.resolve()
                .then(() => this.handler(item))
                .catch((err) => {
                console.error('AIWorkerPool handler error:', err && typeof err === 'object' && 'message' in err
                    ? err.message
                    : err);
            })
                .finally(() => {
                this._inflight--;
                this._drain();
            });
        }
        this._draining = false;
    }
}
exports.AIWorkerPool = AIWorkerPool;
//# sourceMappingURL=AIWorkerPool.js.map