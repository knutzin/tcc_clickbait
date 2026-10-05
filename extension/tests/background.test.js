/**
 * background.test.js — Regression tests for the Service Worker.
 *
 * Loads extension/background/service_worker.js into a Node `vm` context
 * with mocked chrome.*, fetch, and console, then exercises the
 * message-driven behaviour described in SPEC.locked.md.
 *
 *   - simultaneous CLASSIFY_BATCH yields correct total
 *   - RESET_STATS during in-flight batch excludes prior result
 *   - health HTTP 500 / malformed payload → offline
 *   - malformed batch response → reject
 *
 * Runs under `node --test`. No external dependencies.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const WORKER_PATH = path.join(
  __dirname,
  "..",
  "background",
  "service_worker.js"
);
const WORKER_SRC = fs.readFileSync(WORKER_PATH, "utf8");

/**
 * Build a fresh execution environment that loads service_worker.js
 * and returns the message handler plus bookkeeping hooks.
 */
function loadWorker({ fetchImpl, storageState, storageSetImpl } = {}) {
  const calls = {
    listener: null,
    fetch: [],
    storageGet: [],
    storageSet: [],
  };

  const storage = {
    data: { ...(storageState || {}) },
    get(defaults, cb) {
      calls.storageGet.push({ defaults });
      const out = { ...defaults, ...this.data };
      // microtask to mirror real async behaviour
      queueMicrotask(() => cb(out));
    },
    set(values, cb) {
      calls.storageSet.push({ values });
      if (storageSetImpl) return storageSetImpl(this.data, values, cb);
      Object.assign(this.data, values);
      if (cb) queueMicrotask(() => cb());
    },
  };

  const messageHandlers = [];
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          calls.listener = fn;
          messageHandlers.push(fn);
        },
      },
    },
    storage: { local: storage },
  };

  const fakeFetch = async (url, init) => {
    calls.fetch.push({ url, init });
    return fetchImpl ? fetchImpl(url, init) : Promise.reject(new Error("no fetch impl"));
  };

  const ctx = {
    chrome,
    fetch: fakeFetch,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(WORKER_SRC, ctx, { filename: WORKER_PATH });

  // Capture the most recently registered listener (only one in this worker).
  const handler = calls.listener;
  if (typeof handler !== "function") {
    throw new Error("service_worker.js did not register onMessage listener");
  }

  /**
   * Send a message and resolve with whatever the worker sends back.
   * Service worker returns `true` from listener to keep channel open
   * for async sendResponse — we model that here.
   */
  function sendMessage(request) {
    return new Promise((resolve) => {
      const keepOpen = handler(request, {}, (resp) => resolve(resp));
      // If handler returns undefined (sync), nothing else to do.
      if (keepOpen === undefined) {
        // sendResponse was already called synchronously above
        // but if it wasn't, the promise stays pending; tests can
        // fall back to checking the side-effects directly.
      }
    });
  }

  return { sendMessage, storage, calls, handler };
}

const okResult = (i) => ({
  clickbait_label_bot: i % 2,
  probabilidade_clickbait: 0.5 + (i % 5) * 0.1,
});

const okBatch = (n) => ({ resultados: Array.from({ length: n }, (_, i) => okResult(i)) });

// ─── Simultaneous CLASSIFY_BATCH yields correct total ─────────────────────────

test("concurrent CLASSIFY_BATCH updates totals correctly (one shared storage)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (_url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const body = JSON.parse(init.body);
    const n = body.titulos.length;
    // Simulate variable network latency so calls genuinely overlap.
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      json: async () => okBatch(n),
      text: async () => JSON.stringify(okBatch(n)),
    };
  };

  const { sendMessage, storage } = loadWorker({ fetchImpl, storageState: { total: 0, clickbaits: 0 } });

  // Fire three overlapping batches: 4 + 6 + 10 = 20 titles, half clickbait.
  const a = sendMessage({ type: "CLASSIFY_BATCH", titulos: ["a", "b", "c", "d"] });
  const b = sendMessage({ type: "CLASSIFY_BATCH", titulos: ["e", "f", "g", "h", "i", "j"] });
  const c = sendMessage({ type: "CLASSIFY_BATCH", titulos: Array.from({ length: 10 }, (_, k) => `k${k}`) });

  const [ra, rb, rc] = await Promise.all([a, b, c]);

  assert.equal(ra.success, true);
  assert.equal(rb.success, true);
  assert.equal(rc.success, true);
  // Service worker sends back the result list for each call.
  assert.equal(ra.resultados.length, 4);
  assert.equal(rb.resultados.length, 6);
  assert.equal(rc.resultados.length, 10);
  // At least two of the three calls overlapped.
  assert.ok(maxInFlight >= 2, `expected concurrency, got maxInFlight=${maxInFlight}`);

  // Allow microtask queue (set storage callbacks) to drain.
  await new Promise((r) => setTimeout(r, 5));

  // Counted: 20 titles, 10 clickbaits (every other index has label 1).
  assert.equal(storage.data.total, 20, "total should equal 4+6+10");
  assert.equal(storage.data.clickbaits, 10, "clickbaits should be half of total");
});

// ─── RESET_STATS during in-flight batch excludes prior result ─────────────────

test("RESET_STATS issued while batch is in flight discards its counter contribution", async () => {
  let resolveFetch;
  const fetchImpl = (_url, init) =>
    new Promise((resolve) => {
      resolveFetch = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => okBatch(JSON.parse(init.body).titulos.length),
          text: async () => "{}",
        });
    });

  const { sendMessage, storage } = loadWorker({
    fetchImpl,
    storageState: { total: 0, clickbaits: 0 },
  });

  // Start a batch that will stall inside fetch.
  const batchPromise = sendMessage({
    type: "CLASSIFY_BATCH",
    titulos: ["x1", "x2", "x3", "x4", "x5"],
  });

  // Yield so the worker reaches `await fetch(...)`.
  await new Promise((r) => setTimeout(r, 5));

  // While fetch is pending, a tab/observer pushes a fresh batch through the
  // listener which then immediately asks to reset — the reset must run before
  // the in-flight batch's storage.set callback fires.
  const resetPromise = sendMessage({ type: "RESET_STATS" });
  await resetPromise;
  assert.equal(storage.data.total, 0);
  assert.equal(storage.data.clickbaits, 0);

  // Now let the original batch return.
  resolveFetch();
  const result = await batchPromise;
  assert.equal(result.success, true);

  // Drain storage callbacks before checking the final count.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    storage.data.total,
    0,
    "RESET_STATS during in-flight batch should exclude prior result (SPEC: pedidos de geração anterior ao reset não alteram novos contadores)"
  );
  assert.equal(storage.data.clickbaits, 0);
});

test("reset waits for a pending stats write, then newer batch counts once", async () => {
  let finishWrite;
  let writes = 0;
  const { sendMessage, storage } = loadWorker({
    fetchImpl: async (_url, init) => ({
      ok: true, status: 200,
      json: async () => okBatch(JSON.parse(init.body).titulos.length),
    }),
    storageSetImpl(data, values, cb) {
      writes += 1;
      if (writes === 1) {
        finishWrite = () => { Object.assign(data, values); cb(); };
      } else {
        Object.assign(data, values);
        queueMicrotask(cb);
      }
    },
  });
  const first = sendMessage({ type: "CLASSIFY_BATCH", titulos: ["A"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof finishWrite, "function");
  const reset = sendMessage({ type: "RESET_STATS" });
  const newer = sendMessage({ type: "CLASSIFY_BATCH", titulos: ["B"] });
  finishWrite();
  await Promise.all([first, reset, newer]);
  assert.equal(storage.data.total, 1);
});

// ─── Health: HTTP 500 / malformed payload → offline ───────────────────────────

test("CHECK_HEALTH: HTTP 500 reports offline", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error("not json");
    },
    text: async () => "boom",
  });
  const { sendMessage } = loadWorker({ fetchImpl });
  const resp = await sendMessage({ type: "CHECK_HEALTH" });
  assert.equal(resp.online, false);
});

test("CHECK_HEALTH: malformed JSON payload reports offline", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
    text: async () => "not-json",
  });
  const { sendMessage } = loadWorker({ fetchImpl });
  const resp = await sendMessage({ type: "CHECK_HEALTH" });
  assert.equal(resp.online, false);
});

test("CHECK_HEALTH: 200 with non-ok status payload reports offline", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "degraded" }),
    text: async () => JSON.stringify({ status: "degraded" }),
  });
  const { sendMessage } = loadWorker({ fetchImpl });
  const resp = await sendMessage({ type: "CHECK_HEALTH" });
  assert.equal(resp.online, false);
});

// ─── Malformed batch response rejects ────────────────────────────────────────

test("CLASSIFY_BATCH: HTTP 500 rejects with structured error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error("nope");
    },
    text: async () => "internal error",
  });
  const { sendMessage } = loadWorker({ fetchImpl });
  const resp = await sendMessage({ type: "CLASSIFY_BATCH", titulos: ["a"] });
  assert.equal(resp.success, false);
  assert.match(resp.error, /500/);
});

test("CLASSIFY_BATCH: malformed JSON response rejects", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected EOF");
    },
    text: async () => "<<not json>>",
  });
  const { sendMessage } = loadWorker({ fetchImpl });
  const resp = await sendMessage({ type: "CLASSIFY_BATCH", titulos: ["a"] });
  assert.equal(resp.success, false);
  assert.ok(resp.error);
});

test("CLASSIFY_BATCH: payload missing 'resultados' rejects", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ something: "else" }),
    text: async () => '{"something":"else"}',
  });
  const { sendMessage } = loadWorker({ fetchImpl });
  const resp = await sendMessage({ type: "CLASSIFY_BATCH", titulos: ["a"] });
  assert.equal(resp.success, false);
});

// ─── Stats & reset round-trip ────────────────────────────────────────────────

test("GET_STATS returns defaults when storage empty", async () => {
  const { sendMessage } = loadWorker();
  const stats = await sendMessage({ type: "GET_STATS" });
  assert.deepEqual(stats, { total: 0, clickbaits: 0 });
});

test("RESET_STATS zeroes counters and replies success", async () => {
  const { sendMessage, storage } = loadWorker({
    storageState: { total: 99, clickbaits: 7 },
  });
  const resp = await sendMessage({ type: "RESET_STATS" });
  assert.equal(resp && resp.success, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(storage.data.total, 0);
  assert.equal(storage.data.clickbaits, 0);
});
