/**
 * content.test.js — Regression tests for the Content Script.
 *
 * Loads extension/content/content_script.js into a Node `vm` context with
 * lightweight DOM and chrome.* mocks, then exercises the extraction /
 * classification / SPA / retry behaviour described in SPEC.locked.md:
 *
 *   - article h1 with nested .title → keep the full h1 (not the inner span)
 *   - news link card (a) is accepted; navigation/generic h1 is rejected
 *   - chrome failure (offline) frees the candidate and triggers bounded retry
 *   - in-place text change on a re-rendered element reclassifies; a stale
 *     response must not badge the new text
 *   - manual RECHECK_PAGE waits for an actual classification before resolving
 *
 * Runs under `node --test`. No external dependencies.
 *
 * The script uses an IIFE with internal state; we exercise it through
 * observable side effects: chrome.runtime.sendMessage submissions, badges
 * inserted into the DOM, and the body text of badge spans.
 *
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "content",
  "content_script.js"
);
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, "utf8");

// ─── Tiny DOM shim ────────────────────────────────────────────────────────────
// Just enough of Element/Node to exercise the script. We avoid jsdom on
// purpose: no external packages.

function makeNode(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    parentNode: null,
    parentElement: null,
    attrs: {},
    style: {},
    set className(value) {
      this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
    },
    get className() { return [...this.classList._set].join(" "); },
    // Default to a non-null offsetParent so visibility checks pass.
    // Tests that need a hidden element can override this directly.
    offsetParent: { tagName: "DIV" },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    get firstChild() { return this.childNodes[0] || null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.childNodes;
      return siblings[siblings.indexOf(this) + 1] || null;
    },
    get textContent() {
      return this.childNodes
        .map((c) => (c.nodeType === 3 ? c.data : c.textContent))
        .join("");
    },
    set textContent(v) {
      this.childNodes = [];
      this.children = [];
      if (v != null && v !== "") {
        const t = makeTextNode(String(v));
        t.parentNode = this;
        t.parentElement = this;
        this.childNodes.push(t);
        // text nodes are not in .children
      }
    },
    get innerText() { return this.textContent; },
    set innerText(v) { this.textContent = v; },
    getAttributeNames() { return Object.keys(this.attrs); },
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentNode = this;
      child.parentElement = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    },
    remove() {
      const parent = this.parentElement;
      if (parent) {
        parent.childNodes = parent.childNodes.filter((child) => child !== this);
        parent.children = parent.children.filter((child) => child !== this);
      }
      this.parentNode = null;
      this.parentElement = null;
    },
    get isConnected() {
      let el = this;
      while (el) {
        if (el.tagName === "BODY") return true;
        el = el.parentElement;
      }
      return false;
    },
    insertBefore(child, ref) {
      if (child.parentElement) child.remove();
      child.parentNode = this;
      child.parentElement = this;
      if (ref == null) {
        this.childNodes.push(child);
        if (child.nodeType === 1) this.children.push(child);
      } else {
        const i = this.childNodes.indexOf(ref);
        if (i < 0) {
          this.childNodes.push(child);
          if (child.nodeType === 1) this.children.push(child);
        } else {
          this.childNodes.splice(i, 0, child);
          if (child.nodeType === 1) this.children.splice(i, 0, child);
        }
      }
      return child;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    removeAttribute(name) { delete this.attrs[name]; },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSelector(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      const children = [...this.children];
      while (children.length) {
        const child = children.shift();
        if (matchesSelector(child, sel)) return child;
        children.push(...child.children);
      }
      return null;
    },
    querySelectorAll(sel) {
      const found = [];
      const children = [...this.children];
      while (children.length) {
        const child = children.shift();
        if (matchesSelector(child, sel)) found.push(child);
        children.push(...child.children);
      }
      return found;
    },
  };
  return node;
}

function makeTextNode(data) {
  return { nodeType: 3, data: String(data), parentNode: null };
}

function matchesSelector(node, sel) {
  // Extremely small selector matcher. Supports tag names, [attr*='v'],
  // [attr='v'], [attr], and class lists.
  if (!sel) return false;
  if (sel.includes(",")) {
    return sel.split(",").some((s) => matchesSelector(node, s.trim()));
  }
  sel = sel.trim();
  if (sel === "*") return true;

  if (sel === "[role='main']" || sel === "[role='navigation']" || sel === "[itemtype*='Article']") {
    return node.getAttribute(sel.slice(1, sel.indexOf("=")))?.includes(sel.includes("Article") ? "Article" : sel.includes("navigation") ? "navigation" : "main");
  }
  if (sel === "a[href]") return node.tagName === "A" && node.hasAttribute("href");
  if (sel === "[itemprop~='author']") return (node.getAttribute("itemprop") || "").split(/\s+/).includes("author");
  // Tag selector
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(sel)) {
    return node.tagName === sel.toUpperCase();
  }
  // Class selector
  if (sel.startsWith(".")) {
    return node.classList && node.classList.contains(sel.slice(1));
  }
  // [attr*='v']
  let m = sel.match(/^\[([a-zA-Z_-]+)\*=['"]([^'"]+)['"]\]$/);
  if (m) {
    const v = node.attrs[m[1]] || "";
    return v.includes(m[2]);
  }
  // [attr='v']
  m = sel.match(/^\[([a-zA-Z_-]+)=['"]([^'"]+)['"]\]$/);
  if (m) {
    return node.attrs[m[1]] === m[2];
  }
  // [attr]
  m = sel.match(/^\[([a-zA-Z_-]+)\]$/);
  if (m) {
    return Object.prototype.hasOwnProperty.call(node.attrs, m[1]);
  }
  // tag.class
  m = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z0-9_-]+)$/);
  if (m) {
    return node.tagName === m[1].toUpperCase() && node.classList && node.classList.contains(m[2]);
  }
  return false;
}

function makeDocument() {
  const doc = {
    body: null,
    nodes: [], // all elements (for querySelectorAll)
    _create(tag) {
      const n = makeNode(tag);
      this.nodes.push(n);
      return n;
    },
    createElement(tag) { return this._create(tag); },
    createTextNode(data) { return makeTextNode(data); },
    querySelectorAll(sel) {
      return this.nodes.filter((n) => n.isConnected && matchesSelector(n, sel));
    },
    getElementById() { return null; },
  };
  doc.body = doc._create("body");
  return doc;
}

function addClass(node, ...classes) { classes.forEach((c) => node.classList.add(c)); }
function setText(node, text) {
  node.childNodes = [];
  node.children = [];
  if (text != null) {
    const t = makeTextNode(text);
    t.parentNode = node;
    t.parentElement = node;
    node.childNodes.push(t);
    // text nodes are not in .children (mirrors real DOM)
  }
}

// ─── Chrome mock ──────────────────────────────────────────────────────────────

function makeChrome(messageImpl) {
  const handlers = [];
  return {
    runtime: {
      onMessage: { addListener(fn) { handlers.push(fn); } },
      sendMessage(msg) { return Promise.resolve().then(() => messageImpl(msg)); },
    },
    _handlers: handlers,
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

function loadScript({ messageImpl, document: docOverride, fetchImpl, buildDom } = {}) {
  const doc = docOverride || makeDocument();
  const sent = [];
  const chrome = makeChrome((msg) => {
    sent.push(msg);
    if (messageImpl) return messageImpl(msg, doc, sent);
    return { success: false, error: "no impl" };
  });

  // fetch is unused by content_script.js today, but expose it for future
  // tightening and to keep the surface consistent with other suites.
  const fakeFetch = fetchImpl
    || (async () => ({ ok: false, status: 0, statusText: "no fetch" }));

  // We intercept setTimeout so the script's debounce timer (800ms) and
  // its initial classificar pass can be observed. Callers fireTimers()
  // to drain pending timers.
  const pendingTimers = [];
  const wrappedSetTimeout = (fn, ms, ...rest) => {
    const id = pendingTimers.length + 1;
    pendingTimers.push({ id, fn, ms });
    return id;
  };
  const wrappedClearTimeout = (id) => {
    const i = pendingTimers.findIndex((t) => t.id === id);
    if (i >= 0) pendingTimers.splice(i, 1);
  };

  // If a buildDom callback is provided, populate the body *before* the
  // script runs. The IIFE calls classificar() at the end, which will
  // see the populated DOM.
  if (typeof buildDom === "function") {
    buildDom(doc);
  }

  const observerHolder = { current: null };
  const ctx = {
    chrome,
    document: doc,
    fetch: fakeFetch,
    console,
    setTimeout: wrappedSetTimeout,
    clearTimeout: wrappedClearTimeout,
    queueMicrotask,
    Promise,
    MutationObserver: class {
      constructor(cb) {
        this._cb = cb;
        observerHolder.current = this;
      }
      observe() { /* noop */ }
      disconnect() { /* noop */ }
      trigger(records = []) { this._cb && this._cb(records); }
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT_SRC, ctx, { filename: "content_script.js" });
  return { ctx, doc, chrome, sent, pendingTimers, observerHolder };
}

function fireTimers(pendingTimers) {
  const timers = pendingTimers.splice(0, pendingTimers.length);
  for (const t of timers) t.fn();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ticks(n = 20) {
  return new Promise((r) => setTimeout(r, n));
}

async function flush() {
  // Yield repeatedly so any pending message handlers and microtasks drain.
  for (let i = 0; i < 5; i += 1) await ticks(5);
}

function findBadges(root) {
  return root.nodes.filter((n) => n.classList && n.classList.contains("cb-badge"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("article h1 with nested .title keeps full h1 (not just inner span)", async () => {
  const h1Ref = { current: null };
  const spanRef = { current: null };
  const { sent } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h1 = doc.createElement("h1");
      const span = doc.createElement("span");
      addClass(span, "title");
      setText(h1, "Pleno do STF decide nesta quinta-feira ");
      setText(span, "sobre marco temporal indígena");
      h1.appendChild(span);
      article.appendChild(h1);
      doc.body.appendChild(article);
      h1Ref.current = h1;
      spanRef.current = span;
    },
  });

  await flush();

  const h1 = h1Ref.current;
  const span = spanRef.current;
  const submitted = sent
    .filter((m) => m && m.type === "CLASSIFY_BATCH")
    .flatMap((m) => m.titulos);
  assert.deepEqual(submitted, ["Pleno do STF decide nesta quinta-feira sobre marco temporal indígena"]);
  // SPEC invariant: the OUTER h1 is classified, not the inner span.
  // Currently the script's dedup keeps the deepest match (the span),
  // which is the SPEC violation. We assert by checking which element
  // is marked as checked.
  assert.equal(span.getAttribute("data-cb-checked"), null);
  assert.equal(h1.getAttribute("data-cb-checked"), null); // failed API cannot mark success
});

test("article header h1 is kept and linked heading is sent once", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const header = doc.createElement("header");
      const h1 = doc.createElement("h1");
      setText(h1, "Justiça anuncia mudanças relevantes em decisões sobre política pública");
      header.appendChild(h1);
      article.appendChild(header);
      const link = doc.createElement("a");
      link.setAttribute("href", "/noticias/economia");
      const h2 = doc.createElement("h2");
      setText(h2, "Ministério anuncia novas regras econômicas para o próximo semestre");
      link.appendChild(h2);
      article.appendChild(link);
      doc.body.appendChild(article);
    },
  });
  await flush();
  const titulos = sent.filter((m) => m.type === "CLASSIFY_BATCH").flatMap((m) => m.titulos);
  assert.deepEqual(titulos, [
    "Justiça anuncia mudanças relevantes em decisões sobre política pública",
    "Ministério anuncia novas regras econômicas para o próximo semestre",
  ]);
});

test("news link card is classified (not just h1 elements)", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const link = doc.createElement("a");
      link.setAttribute("href", "/noticias/medidas-2026");
      link.setAttribute("itemprop", "headline");
      setText(link, "Governo anuncia pacote de medidas para reduzir impostos em 2026");
      article.appendChild(link);
      doc.body.appendChild(article);
    },
  });

  await flush();

  const submitted = sent
    .filter((m) => m && m.type === "CLASSIFY_BATCH")
    .flatMap((m) => m.titulos);
  assert.ok(
    submitted.includes("Governo anuncia pacote de medidas para reduzir impostos em 2026"),
    "news link card should be classified; got: " + JSON.stringify(submitted)
  );
});

test("main accepts linked heading once but ignores generic section headings", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const main = doc.createElement("main");
      const h2 = doc.createElement("h2");
      setText(h2, "Explore as principais editorias e serviços do portal");
      main.appendChild(h2);
      const h3 = doc.createElement("h3");
      const link = doc.createElement("a");
      link.setAttribute("href", "/noticia/educacao");
      link.setAttribute("itemprop", "headline");
      setText(link, "Ministério anuncia novas medidas para melhorar ensino público");
      h3.appendChild(link);
      main.appendChild(h3);
      doc.body.appendChild(main);
    },
  });
  await flush();
  const titulos = sent.filter((m) => m.type === "CLASSIFY_BATCH").flatMap((m) => m.titulos);
  assert.deepEqual(titulos, ["Ministério anuncia novas medidas para melhorar ensino público"]);
});

test("unmarked linked main heading is not mistaken for a headline", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const main = doc.createElement("main");
      const link = doc.createElement("a");
      link.setAttribute("href", "/editorias");
      const h2 = doc.createElement("h2");
      setText(h2, "Conheça todas as editorias e serviços disponíveis neste portal");
      link.appendChild(h2);
      main.appendChild(link);
      doc.body.appendChild(main);
    },
  });
  await flush();
  assert.equal(sent.filter((msg) => msg.type === "CLASSIFY_BATCH").length, 0);
});

test("main section heading is ignored without article or news link", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const main = doc.createElement("main");
      const h2 = doc.createElement("h2");
      setText(h2, "Explore as principais editorias e serviços do portal");
      main.appendChild(h2);
      doc.body.appendChild(main);
    },
  });
  await flush();
  assert.equal(sent.filter((msg) => msg.type === "CLASSIFY_BATCH").length, 0);
});

test("article h1 suppresses unlinked unmarked secondary heading", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h1 = doc.createElement("h1");
      setText(h1, "Senado aprova novas medidas de segurança nas estradas do país");
      article.appendChild(h1);
      const h2 = doc.createElement("h2");
      setText(h2, "Veja também outras matérias interessantes da nossa redação");
      article.appendChild(h2);
      doc.body.appendChild(article);
    },
  });
  await flush();
  const titles = sent.filter((m) => m.type === "CLASSIFY_BATCH").flatMap((m) => m.titulos);
  assert.deepEqual(titles, ["Senado aprova novas medidas de segurança nas estradas do país"]);
});

test("unmarked article metadata links are not submitted as headlines", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h1 = doc.createElement("h1");
      setText(h1, "Senado aprova novas medidas de segurança nas estradas do país");
      article.appendChild(h1);
      const author = doc.createElement("a");
      author.setAttribute("href", "/equipe");
      author.setAttribute("rel", "author");
      author.setAttribute("itemprop", "headline");
      setText(author, "Conheça todas as reportagens publicadas por nossa equipe editorial");
      article.appendChild(author);
      const metadata = doc.createElement("a");
      metadata.setAttribute("href", "/politica-editorial");
      setText(metadata, "Leia nossas regras editoriais e políticas de privacidade");
      article.appendChild(metadata);
      doc.body.appendChild(article);
    },
  });
  await flush();
  const titulos = sent.filter((m) => m.type === "CLASSIFY_BATCH").flatMap((m) => m.titulos);
  assert.deepEqual(titulos, ["Senado aprova novas medidas de segurança nas estradas do país"]);
});

test("generic h1 in site chrome (no article/main wrapper) is rejected", async () => {
  const { sent } = loadScript({
    buildDom: (doc) => {
      // Site nav: a short h1 in <header>
      const header = doc.createElement("header");
      const h1 = doc.createElement("h1");
      setText(h1, "Bem-vindo ao portal de notícias e serviços da cidade");
      header.appendChild(h1);
      doc.body.appendChild(header);

      // Real article below
      const article = doc.createElement("article");
      const h2 = doc.createElement("h2");
      setText(h2, "Presidente anuncia nova política econômica para o próximo ano");
      article.appendChild(h2);
      doc.body.appendChild(article);
    },
  });

  await flush();

  const submitted = sent
    .filter((m) => m && m.type === "CLASSIFY_BATCH")
    .flatMap((m) => m.titulos);
  assert.ok(
    !submitted.some((t) => t.includes("Bem-vindo ao portal")),
    "site chrome h1 must not be classified; got: " + JSON.stringify(submitted)
  );
  assert.ok(
    submitted.some((t) => t.includes("Presidente anuncia nova política")),
    "real article h2 should be classified; got: " + JSON.stringify(submitted)
  );
});

test("chrome failure frees the candidate and schedules bounded retry", async () => {
  let attempts = 0;
  const h2Ref = { current: null };
  const { sent, pendingTimers, observerHolder } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h2 = doc.createElement("h2");
      setText(h2, "Senado aprova novo marco regulatório para inteligência artificial");
      article.appendChild(h2);
      doc.body.appendChild(article);
      h2Ref.current = h2;
    },
    messageImpl: (msg) => {
      if (msg && msg.type === "CLASSIFY_BATCH") {
        attempts += 1;
        return { success: false, error: "service worker offline" };
      }
      return { success: false, error: "unsupported" };
    },
  });

  // First pass (initial classificar)
  await flush();
  const firstCount = attempts;
  assert.ok(firstCount >= 1, "first attempt should have happened");

  // SPEC invariant 1: after failure, the candidate's data-cb-checked
  // attribute must be cleared so it is eligible for re-extraction.
  const h2 = h2Ref.current;
  const checkedAfterFailure = h2.getAttribute("data-cb-checked");
  assert.equal(
    checkedAfterFailure,
    null,
    "candidate must be freed after failure (data-cb-checked cleared); got: " + checkedAfterFailure
  );

  // Automatic retries happen without a DOM mutation; after exhaustion they stop.
  for (let i = 0; i < 6; i += 1) {
    fireTimers(pendingTimers);
    await flush();
  }
  assert.ok(attempts > firstCount);
  assert.ok(attempts <= 4, `retry must stop after three delays; got ${attempts}`);
  observerHolder.current?.trigger();
  fireTimers(pendingTimers);
  await flush();
  assert.equal(attempts, 4);
  assert.ok(sent.length >= 1);
});

test("several failed batches consume only one retry round", async () => {
  let chamadas = 0;
  const { pendingTimers } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      for (let i = 0; i < 151; i += 1) {
        const h2 = doc.createElement("h2");
        setText(h2, `Assembleia debate nova medida pública número ${i} para todo o estado`);
        article.appendChild(h2);
      }
      doc.body.appendChild(article);
    },
    messageImpl: () => { chamadas += 1; return { success: false, error: "offline" }; },
  });
  await flush();
  assert.equal(chamadas, 4);
  fireTimers(pendingTimers);
  await flush();
  assert.equal(chamadas, 8, "uma nova rodada deve tentar todos os lotes");
});

test("new SPA headline still classifies after retries exhaust", async () => {
  let attempts = 0;
  let h2;
  const { pendingTimers, observerHolder } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      h2 = doc.createElement("h2");
      setText(h2, "Primeira notícia sobre reforma aprovada nesta semana no Senado");
      article.appendChild(h2);
      doc.body.appendChild(article);
    },
    messageImpl: () => { attempts += 1; return { success: false, error: "offline" }; },
  });
  await flush();
  for (let i = 0; i < 5; i += 1) {
    fireTimers(pendingTimers);
    await flush();
  }
  assert.equal(attempts, 4);
  setText(h2, "Nova notícia com decisão diferente divulgada após navegação SPA");
  observerHolder.current.trigger();
  fireTimers(pendingTimers);
  await flush();
  assert.equal(attempts, 5);
});

test("stale response does not badge text different from the submission", async () => {
  let pending = null;
  const h1Ref = { current: null };
  const { doc, sent } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h1 = doc.createElement("h1");
      setText(h1, "Texto original da manchete com tamanho suficiente para passar");
      article.appendChild(h1);
      doc.body.appendChild(article);
      h1Ref.current = h1;
    },
    messageImpl: (msg) => {
      if (msg && msg.type === "CLASSIFY_BATCH") {
        return new Promise((resolve) => {
          pending = { msg, resolve };
        });
      }
      return { success: false };
    },
  });

  // The IIFE's initial classificar kicks off the pending request.
  await flush();

  // Mutate text in place before the response resolves
  const h1 = h1Ref.current;
  assert.ok(h1, "expected h1 to be captured");
  setText(h1, "Texto completamente diferente reativo a navegação SPA");

  assert.ok(pending, "expected a pending CLASSIFY_BATCH");
  pending.resolve({
    success: true,
    resultados: [{ clickbait_label_bot: 0, probabilidade_clickbait: 0.12 }],
  });
  await flush();

  // The badge, if applied, must not reference the mutated text.
  const badges = findBadges(doc);
  for (const b of badges) {
    const title = b.attrs.title || "";
    assert.ok(
      !title.includes("Texto completamente diferente"),
      "stale badge must not reference mutated text; got title=" + title
    );
  }
  assert.equal(badges.length, 0, "stale response must not attach any badge");
});

test("removed SPA headline clears sibling badge and reinsertion is classified", async () => {
  let calls = 0;
  const { doc, observerHolder, pendingTimers } = loadScript({
    buildDom: (d) => {
      const article = d.createElement("article");
      const h2 = d.createElement("h2");
      setText(h2, "Conselho anuncia nova diretriz para universidades de todo país");
      article.appendChild(h2);
      d.body.appendChild(article);
    },
    messageImpl: (msg) => {
      calls += 1;
      return { success: true, resultados: msg.titulos.map(() => ({
        clickbait_label_bot: 0, probabilidade_clickbait: 0.1,
      })) };
    },
  });
  await flush();
  const h2 = doc.nodes.find((el) => el.tagName === "H2");
  const article = h2.parentElement;
  assert.equal(findBadges(doc).filter((el) => el.isConnected).length, 1);
  h2.remove();
  observerHolder.current.trigger([{ type: "childList", target: article,
    removedNodes: [h2], addedNodes: [] }]);
  fireTimers(pendingTimers);
  await flush();
  assert.equal(findBadges(doc).filter((el) => el.isConnected).length, 0);
  article.appendChild(h2);
  observerHolder.current.trigger([{ type: "childList", target: article,
    removedNodes: [], addedNodes: [h2] }]);
  fireTimers(pendingTimers);
  await flush();
  assert.equal(calls, 2);
  assert.equal(findBadges(doc).filter((el) => el.isConnected).length, 1);
});

test("moving a classified headline preserves badge beside its new position", async () => {
  let calls = 0;
  const { doc, observerHolder, pendingTimers } = loadScript({
    buildDom: (d) => {
      const first = d.createElement("article");
      const second = d.createElement("article");
      const h2 = d.createElement("h2");
      setText(h2, "Conselho aprova novas diretrizes para universidades neste semestre");
      first.appendChild(h2);
      d.body.appendChild(first);
      d.body.appendChild(second);
    },
    messageImpl: (msg) => {
      calls += 1;
      return { success: true, resultados: msg.titulos.map(() => ({
        clickbait_label_bot: 0, probabilidade_clickbait: 0.1,
      })) };
    },
  });
  await flush();
  const [first, second] = doc.nodes.filter((el) => el.tagName === "ARTICLE");
  const h2 = doc.nodes.find((el) => el.tagName === "H2");
  const badge = findBadges(doc)[0];
  assert.equal(calls, 1);
  second.appendChild(h2);
  observerHolder.current.trigger([{ type: "childList", target: first,
    removedNodes: [h2], addedNodes: [] }]);
  fireTimers(pendingTimers);
  await flush();
  assert.equal(calls, 1);
  assert.equal(badge.parentElement, second);
  assert.equal(badge.nextSibling, h2);
});

test("moving a wrapper keeps descendant headline badge adjacent", async () => {
  let calls = 0;
  const { doc, observerHolder, pendingTimers } = loadScript({
    buildDom: (d) => {
      const first = d.createElement("article");
      const second = d.createElement("article");
      const wrapper = d.createElement("div");
      const h2 = d.createElement("h2");
      setText(h2, "Conselho anuncia mudanças nas regras de saúde pública no estado");
      wrapper.appendChild(h2);
      first.appendChild(wrapper);
      d.body.appendChild(first);
      d.body.appendChild(second);
    },
    messageImpl: (msg) => {
      calls += 1;
      return { success: true, resultados: msg.titulos.map(() => ({
        clickbait_label_bot: 0, probabilidade_clickbait: 0.1,
      })) };
    },
  });
  await flush();
  const first = doc.nodes.find((el) => el.tagName === "ARTICLE");
  const second = doc.nodes.filter((el) => el.tagName === "ARTICLE")[1];
  const wrapper = doc.nodes.find((el) => el.tagName === "DIV");
  const h2 = doc.nodes.find((el) => el.tagName === "H2");
  const badge = findBadges(doc)[0];
  second.appendChild(wrapper);
  observerHolder.current.trigger([{ type: "childList", target: first,
    removedNodes: [wrapper], addedNodes: [] }]);
  fireTimers(pendingTimers);
  await flush();
  assert.equal(calls, 1);
  assert.equal(badge.parentElement, wrapper);
  assert.equal(badge.nextSibling, h2);
});

test("shortened SPA headline loses obsolete badge", async () => {
  const { doc, observerHolder, pendingTimers } = loadScript({
    buildDom: (d) => {
      const article = d.createElement("article");
      const h2 = d.createElement("h2");
      setText(h2, "Câmara aprova novas medidas de proteção ambiental para o estado");
      article.appendChild(h2);
      d.body.appendChild(article);
    },
    messageImpl: (msg) => ({ success: true, resultados: msg.titulos.map(() => ({
      clickbait_label_bot: 0, probabilidade_clickbait: 0.1,
    })) }),
  });
  await flush();
  const h2 = doc.nodes.find((el) => el.tagName === "H2");
  assert.equal(h2.getAttribute("data-cb-checked"), "1");
  setText(h2, "Aviso");
  observerHolder.current.trigger();
  fireTimers(pendingTimers);
  await flush();
  assert.equal(h2.getAttribute("data-cb-checked"), null);
  assert.equal(findBadges(doc).filter((el) => el.isConnected).length, 0);
});

test("in-place text change on a checked element reclassifies the new text", async () => {
  const h2Ref = { current: null };
  const { sent, pendingTimers, observerHolder } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h2 = doc.createElement("h2");
      setText(h2, "Manchete inicial com mais de vinte caracteres de comprimento");
      article.appendChild(h2);
      doc.body.appendChild(article);
      h2Ref.current = h2;
    },
  });

  // Initial classification
  await flush();
  const firstBatch = sent.filter((m) => m && m.type === "CLASSIFY_BATCH");
  assert.ok(firstBatch.length >= 1, "initial classification should run");

  // Reset sent log
  sent.length = 0;

  // Mutate the h2's text in place
  const h2 = h2Ref.current;
  setText(h2, "Nova manchete completamente diferente após navegação SPA interna");

  // Fire the captured MutationObserver to simulate a DOM mutation
  // (e.g. SPA route change). The observer's debounce timer (800ms)
  // schedules classificar; we fire it.
  assert.ok(observerHolder.current, "MutationObserver must have been created");
  observerHolder.current.trigger();
  fireTimers(pendingTimers);
  await flush();
  // Fire again in case the debounce re-scheduled
  fireTimers(pendingTimers);
  await flush();

  const submittedAfter = sent
    .filter((m) => m && m.type === "CLASSIFY_BATCH")
    .flatMap((m) => m.titulos);
  assert.ok(
    submittedAfter.includes("Nova manchete completamente diferente após navegação SPA interna"),
    "text-changed element should be reclassified; got: " + JSON.stringify(submittedAfter)
  );
});

test("manual RECHECK_PAGE waits for classification before resolving", async () => {
  let acknowledge;
  let classified = 0;
  const { chrome } = loadScript({
    buildDom: (doc) => {
      const article = doc.createElement("article");
      const h2 = doc.createElement("h2");
      setText(h2, "Assembleia aprova novas regras de proteção ambiental no estado");
      article.appendChild(h2);
      doc.body.appendChild(article);
    },
    messageImpl: (msg) => {
      if (msg.type !== "CLASSIFY_BATCH") return { success: false };
      classified += 1;
      return new Promise((resolve) => {
        acknowledge = () => resolve({ success: true, resultados: msg.titulos.map(() => ({
          clickbait_label_bot: 0, probabilidade_clickbait: 0.1,
        })) });
      });
    },
  });
  await flush();
  const respostas = [];
  for (const handler of chrome._handlers) {
    handler({ type: "RECHECK_PAGE" }, {}, (resposta) => respostas.push(resposta));
  }
  await flush();
  assert.equal(respostas.length, 0, "não pode responder antes da classificação");
  assert.ok(classified > 0);
  acknowledge();
  await flush();
  if (respostas.length === 0) {
    acknowledge();
    await flush();
  }
  assert.equal(respostas.length, 1);
  assert.equal(respostas[0].success, true);
});
