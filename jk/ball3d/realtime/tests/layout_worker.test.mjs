import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LayoutWorkerClient } from "../src/layout_worker_client.mjs";
import { geometryDefaults } from "../src/settings.mjs";

const source = fs.readFileSync(new URL("../src/layout.mjs", import.meta.url), "utf8");
const request = () => ({ source, geometry: geometryDefaults(), plan: {
  duration: 3, landings: [{ t: 1, n: 1, midi: 60, dur: .5 }],
} });
let originalWorker;
class TestWorker {
  static instances = [];
  constructor(url, options) {
    this.url = url; this.options = options; this.stopped = false;
    TestWorker.instances.push(this);
  }
  postMessage(data) { this.request = data; }
  terminate() { this.stopped = true; }
  reply(data) { this.onmessage({ data }); }
}
beforeEach(() => {
  originalWorker = globalThis.Worker;
  globalThis.Worker = TestWorker;
  TestWorker.instances = [];
});
afterEach(() => { globalThis.Worker = originalWorker; });

test("completed layouts preserve the request snapshot and reuse the cache", async () => {
  const client = new LayoutWorkerClient("/worker.js");
  const input = request(), frozen = structuredClone(input);
  const pending = client.solve(input);
  const worker = TestWorker.instances[0];
  input.geometry.board_w = .40;
  input.plan.landings[0].midi = 72;
  assert.deepEqual(worker.request, frozen);
  worker.reply({ layout: { boards: [{ midi: 60 }] } });
  const result = await pending;
  assert.equal(result.kit.BOARD_W, frozen.geometry.board_w);
  assert.equal(worker.stopped, true);
  assert.equal(await client.solve(frozen), result);
  assert.equal(TestWorker.instances.length, 1);
  const changed = client.solve(input);
  TestWorker.instances[1].reply({ layout: { boards: [{ midi: 72 }] } });
  assert.notEqual((await changed).key, result.key);
});

test("phrase layering uses a separate worker cache while each mode reuses its result",async()=>{
  const client=new LayoutWorkerClient("/worker.js"),input=request();
  input.presentation=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  const layered=client.solve(input);
  TestWorker.instances[0].reply({layout:{boards:["layered"]}});
  const row=await layered;
  assert.equal(await client.solve(input),row);
  input.presentation.spatial.layeredPhrases=false;
  const classic=client.solve(input);
  assert.equal(TestWorker.instances.length,2);
  TestWorker.instances[1].reply({layout:{boards:["classic"]}});
  const previous=await classic;
  assert.notEqual(previous.key,row.key);
  input.presentation.spatial.layeredPhrases=true;
  assert.equal(await client.solve(input),row);
  assert.equal(TestWorker.instances.length,2);
});

test("cancel terminates CPU work and permits retrying the same uncached request", async () => {
  const client = new LayoutWorkerClient("/worker.js");
  const old = client.solve(request());
  const rejected = assert.rejects(old, { name: "AbortError" });
  client.cancel();
  assert.equal(TestWorker.instances[0].stopped, true);
  await rejected;
  const next = client.solve(request());
  TestWorker.instances[1].reply({ layout: { boards: [] } });
  await next;
  assert.equal(client.active, null);
});

test("a queued old result cannot be cached or clear a newer active task", async () => {
  const client = new LayoutWorkerClient("/worker.js");
  const old = client.solve(request());
  const rejected = assert.rejects(old, { name: "AbortError" });
  TestWorker.instances[0].reply({ layout: { boards: ["stale"] } });
  const next = client.solve(request());
  await rejected;
  assert.equal(client.cache.size, 0);
  assert.equal(client.active.worker, TestWorker.instances[1]);
  TestWorker.instances[1].reply({ layout: { boards: ["current"] } });
  assert.deepEqual((await next).layout.boards, ["current"]);
});

test("worker errors clean up and do not cache a failed result", async () => {
  const client = new LayoutWorkerClient("/worker.js");
  const failed = client.solve(request());
  const rejected = assert.rejects(failed, /solver failed/);
  TestWorker.instances[0].reply({ error: "solver failed" });
  await rejected;
  assert.equal(client.active, null);
  assert.equal(client.cache.size, 0);
  const retry = client.solve(request());
  const rejectedAgain = assert.rejects(retry, /worker crashed/);
  let prevented = false;
  TestWorker.instances[1].onerror({ message: "worker crashed", preventDefault() { prevented = true; } });
  await rejectedAgain;
  assert.equal(prevented, true);
  assert.equal(TestWorker.instances[1].stopped, true);
});


test("progress messages do not finish a task, and cancelled progress is ignored", async () => {
  const client = new LayoutWorkerClient("/worker.js"), updates = [];
  const pending = client.solve(request(), undefined, p => updates.push(p));
  const worker = TestWorker.instances[0];
  worker.reply({ progress: { stage: "排列木板", percent: 30 } });
  await Promise.resolve();
  assert.equal(client.active.worker, worker);
  assert.equal(updates.length, 1);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  client.cancel();
  worker.reply({ progress: { stage: "排列木板", percent: 80 } });
  await rejected;
  assert.equal(updates.length, 1);
});
