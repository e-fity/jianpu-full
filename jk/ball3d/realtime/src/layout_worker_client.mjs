import { layoutKey, loadKit } from "./layout_kit.mjs";
import { createGravityKit } from "./gravity_layout.mjs";

/** One cancellable CPU task, plus the last eight completed layouts. */
export class LayoutWorkerClient {
  constructor(url) {
    this.url = url;
    this.active = null;
    this.cache = new Map();
  }

  cancel() {
    if (!this.active) return;
    const job = this.active;
    this.active = null;
    job.worker.terminate();
    job.reject(new DOMException("排版已取消", "AbortError"));
  }

  async solve(request, importModule, onProgress) {
    this.cancel();
    // GUI objects can change while the worker runs; commit only this snapshot.
    const snapshot = structuredClone(request);
    const key = layoutKey(snapshot);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const worker = new Worker(this.url, { type: "module" });
    const job = { worker, reject: null };
    const pending = new Promise((resolve, reject) => {
      job.reject = reject;
      worker.onmessage = ({ data }) => {
        if (this.active !== job) return;
        if (data.progress) { onProgress?.(data.progress); return; }
        if (data.error) reject(new Error(data.error));
        else resolve(data.layout);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message || "后台排版线程启动失败"));
      };
      worker.onmessageerror = () => reject(new Error("后台排版结果读取失败"));
      worker.postMessage(snapshot);
    });
    this.active = job;
    try {
      const [base, layout] = await Promise.all([
        loadKit(snapshot.source, snapshot.geometry, importModule), pending,
      ]);
      // A completed message may already be queued when the user cancels.
      if (this.active !== job) throw new DOMException("排版已取消", "AbortError");
      const kit = snapshot.presentation ? createGravityKit(base, snapshot.presentation) : base;
      const result = { key, kit, layout };
      this.cache.set(key, result);
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
      return result;
    } finally {
      worker.terminate();
      if (this.active === job) this.active = null;
    }
  }
}
