/**
 * popup.test.js — Regression tests for popup.js.
 *
 * Loads extension/popup/popup.js into a vm context with a mocked DOM,
 * chrome.* APIs, and a stubbed tab message that signals content
 * script completion.
 *
 *   - manual recheck awaits content completion, not a fixed 1200ms
 *   - absent content script / restricted tab restores the button with error
 *   - offline manual retry remains available
 *   - manifest permission and persistent stats label
 *
 * Runs under `node --test`. No external dependencies.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.js");
const MANIFEST_PATH = path.join(__dirname, "..", "manifest.json");
const POPUP_SRC = fs.readFileSync(POPUP_PATH, "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

// ─── Tiny DOM stub ───────────────────────────────────────────────────────────

function makeEl(tag = "div") {
  const el = {
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    style: { display: "" },
    children: [],
    attrs: {},
    listeners: {},
    parentElement: null,
    disabled: false,
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx >= 0) el.children.splice(idx, 1);
      child.parentElement = null;
    },
    addEventListener(ev, fn) {
      (el.listeners[ev] = el.listeners[ev] || []).push(fn);
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete el.attrs[k];
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attrs, k);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

function makeDocument() {
  const elements = {};
  return {
    _elements: elements,
    getElementById(id) {
      if (!elements[id]) elements[id] = makeEl("div");
      return elements[id];
    },
    createElement(tag) {
      return makeEl(tag);
    },
  };
}

/**
 * Build a popup environment and load popup.js inside it.
 * Returns a controller with all the chrome.* and DOM hooks the test can drive.
 */
function loadPopup({
  healthOnline = true,
  tabMessageImpl,
  tabsQueryImpl,
  sendMessageImpl,
} = {}) {
  const sentMessages = [];
  const dom = makeDocument();

  const chrome = {
    runtime: {
      sendMessage: (msg) => {
        sentMessages.push(msg);
        if (sendMessageImpl) return sendMessageImpl(msg);
        // default: echo GET_STATS / RESET_STATS, online/offline health
        if (msg?.type === "CHECK_HEALTH") {
          return Promise.resolve(
            healthOnline
              ? { online: true, data: { status: "ok" } }
              : { online: false }
          );
        }
        if (msg?.type === "GET_STATS") {
          return Promise.resolve({ total: 0, clickbaits: 0 });
        }
        if (msg?.type === "RESET_STATS") {
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({});
      },
    },
    tabs: {
      query: () => {
        if (tabsQueryImpl) return tabsQueryImpl();
        return Promise.resolve([{ id: 42 }]);
      },
      sendMessage: (tabId, msg) => {
        sentMessages.push(msg);
        if (tabMessageImpl) return tabMessageImpl(tabId, msg);
        return Promise.resolve({ success: true });
      },
    },
    storage: { onChanged: { addListener() {} } },
  };

  const ctx = {
    chrome,
    document: dom,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(POPUP_SRC, ctx, { filename: POPUP_PATH });

  return {
    dom,
    sentMessages,
    click(btn) {
      const handlers = btn.listeners.click || [];
      for (const h of handlers) h();
    },
    get btnVerificar() {
      return dom.getElementById("btn-verificar");
    },
    get btnReset() {
      return dom.getElementById("btn-reset");
    },
  };
}

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ─── Manifest: no new permissions, sensible label, persistent stats ──────────

test("manifest: loopback host and only activeTab/storage permissions", () => {
  assert.deepEqual([...MANIFEST.permissions].sort(), ["activeTab", "storage"]);
  assert.deepEqual(MANIFEST.host_permissions, ["http://127.0.0.1:8000/*"]);
  assert.equal(MANIFEST.manifest_version, 3);
});

test("popup describes persistent counters", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.html"), "utf8");
  assert.match(html, /Desde o último reset/);
  assert.doesNotMatch(html, /Esta sessão/);
});

// ─── Online path ─────────────────────────────────────────────────────────────

test("online: status text and stats render correctly", async () => {
  const p = loadPopup({ healthOnline: true });
  await flush();
  const status = p.dom.getElementById("api-status");
  const tip = p.dom.getElementById("offline-tip");
  assert.equal(status.textContent, "🟢 Online");
  assert.equal(status.className, "status-text status-online");
  assert.equal(tip.style.display, "none");
  assert.equal(p.btnVerificar.disabled, false);
});

// ─── Offline path: manual recheck still available ────────────────────────────

test("offline: button stays enabled so the user can still retry manually", async () => {
  // Per SPEC: "botão manual continua disponível mesmo quando API offline."
  const p = loadPopup({ healthOnline: false });
  await flush();
  const status = p.dom.getElementById("api-status");
  const tip = p.dom.getElementById("offline-tip");
  assert.equal(status.textContent, "🔴 Offline");
  assert.equal(tip.style.display, "block");
  // Spec requires: button remains clickable even when API is offline.
  assert.equal(
    p.btnVerificar.disabled,
    false,
    "manual retry must remain available when API is offline (SPEC)"
  );
});

// ─── Manual recheck awaits content completion, not a fixed 1200ms ───────────

test("manual recheck waits for tab acknowledgement before restoring button and stats", async () => {
  let acknowledge;
  const p = loadPopup({
    tabMessageImpl: () => new Promise((resolve) => { acknowledge = resolve; }),
    sendMessageImpl: (msg) => Promise.resolve(msg.type === "CHECK_HEALTH"
      ? { online: true } : { total: 4, clickbaits: 2 }),
  });
  await flush();
  p.click(p.btnVerificar);
  await flush();
  assert.equal(p.btnVerificar.disabled, true);
  assert.ok(p.sentMessages.some((msg) => msg.type === "RECHECK_PAGE"));
  const reads = () => p.sentMessages.filter((msg) => msg.type === "GET_STATS").length;
  const initialReads = reads();
  acknowledge({ success: true });
  await flush();
  assert.equal(p.btnVerificar.disabled, false);
  assert.equal(reads(), initialReads + 1);
});

// ─── Absent content script / restricted tab restores button with error ───────

test("late startup health cannot overwrite a manual recheck failure", async () => {
  let finishHealth;
  const p = loadPopup({
    sendMessageImpl: (msg) => msg.type === "CHECK_HEALTH"
      ? new Promise((resolve) => { finishHealth = resolve; })
      : Promise.resolve({ total: 0, clickbaits: 0 }),
    tabMessageImpl: () => Promise.reject(new Error("Receiving end does not exist")),
  });
  await flush();
  p.click(p.btnVerificar);
  await flush();
  assert.match(p.dom.getElementById("api-status").textContent, /Falha/);
  finishHealth({ online: true });
  await flush();
  assert.match(p.dom.getElementById("api-status").textContent, /Falha/);
  assert.equal(p.btnVerificar.disabled, false);
});

test("successful reset does not strand pending startup health", async () => {
  let finishHealth;
  const p = loadPopup({ sendMessageImpl: (msg) => {
    if (msg.type === "CHECK_HEALTH") return new Promise((resolve) => { finishHealth = resolve; });
    if (msg.type === "RESET_STATS") return Promise.resolve({ success: true });
    return Promise.resolve({ total: 0, clickbaits: 0 });
  } });
  await flush();
  p.click(p.btnReset);
  await flush();
  finishHealth({ online: true });
  await flush();
  assert.equal(p.dom.getElementById("api-status").textContent, "🟢 Online");
});

test("manual recheck: missing content script restores button and surfaces failure", async () => {
  const rejections = [];
  const onRej = (err) => rejections.push(err);
  process.on("unhandledRejection", onRej);
  try {
    const p = loadPopup({
      tabMessageImpl: () => Promise.reject(new Error("Receiving end does not exist.")),
    });
    await flush();
    p.click(p.btnVerificar);
    await flush(60);
    // Spec: popup restaura botão e apresenta falha. The current code does
    // neither — it leaves the button disabled forever and surfaces nothing.
    assert.equal(
      p.btnVerificar.disabled,
      false,
      "button must be restored when content script cannot be injected (SPEC)"
    );
    assert.equal(
      p.btnVerificar.textContent,
      "▶ Verificar página agora",
      "button label must be restored on failure (SPEC)"
    );
    assert.match(p.dom.getElementById("api-status").textContent, /erro|falha/i);
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

test("manual recheck: no active tab restores button with error", async () => {
  const rejections = [];
  const onRej = (err) => rejections.push(err);
  process.on("unhandledRejection", onRej);
  try {
    const p = loadPopup({
      tabsQueryImpl: () => Promise.resolve([]),
    });
    await flush();
    p.click(p.btnVerificar);
    await flush(40);
    assert.equal(
      p.btnVerificar.disabled,
      false,
      "button must be restored when no active tab is available (SPEC)"
    );
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

test("manual recheck: restricted URL (chrome://) restores button with error", async () => {
  const rejections = [];
  const onRej = (err) => rejections.push(err);
  process.on("unhandledRejection", onRej);
  try {
    let received;
    const p = loadPopup({
      tabMessageImpl: (_tabId, msg) => {
        received = msg;
        return Promise.reject(new Error("Cannot message a chrome:// URL."));
      },
    });
    await flush();
    p.click(p.btnVerificar);
    await flush(40);
    assert.equal(received.type, "RECHECK_PAGE");
    assert.equal(
      p.btnVerificar.disabled,
      false,
      "button must be restored on restricted-URL failure (SPEC)"
    );
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

// ─── Reset button ────────────────────────────────────────────────────────────

test("reset: clears stats and re-renders zeros", async () => {
  const p = loadPopup({ healthOnline: true });
  await flush();
  p.click(p.btnReset);
  await flush(20);
  const types = p.sentMessages.map((m) => m.type);
  assert.ok(types.includes("RESET_STATS"));
  assert.equal(p.dom.getElementById("stat-total").textContent, 0);
  assert.equal(p.dom.getElementById("stat-clickbaits").textContent, 0);
});
