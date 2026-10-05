// Service Worker — comunica o content script com a API local e mantém os contadores.

const API_BASE = "http://127.0.0.1:8000";
const API_LOTE = `${API_BASE}/classificar-lote`;
const API_HEALTH = `${API_BASE}/health`;
const STATS_DEFAULT = { total: 0, clickbaits: 0 };

let filaStats = Promise.resolve();
let geracaoStats = 0;

function enfileirarStats(operacao) {
  const resultado = filaStats.then(operacao);
  filaStats = resultado.catch((err) => {
    console.warn("[Clickbait Detector] Erro nos contadores:", err);
  });
  return resultado;
}

function lerStats() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(STATS_DEFAULT, (stats) => {
      const erro = chrome.runtime.lastError;
      if (erro) reject(new Error(erro.message));
      else resolve(stats);
    });
  });
}

function gravarStats(stats) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(stats, () => {
      const erro = chrome.runtime.lastError;
      if (erro) reject(new Error(erro.message));
      else resolve();
    });
  });
}

function atualizarContadores(resultados, geracao) {
  return enfileirarStats(async () => {
    if (geracao !== geracaoStats) return;
    const stats = await lerStats();
    if (geracao !== geracaoStats) return;
    await gravarStats({
      total: stats.total + resultados.length,
      clickbaits: stats.clickbaits + resultados.filter((r) => r.clickbait_label_bot === 1).length,
    });
  });
}

function opcoesFetch() {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? { signal: AbortSignal.timeout(20000) }
    : {};
}

async function classificarLote(titulos) {
  if (!Array.isArray(titulos) || titulos.length < 1 || titulos.length > 50 ||
      titulos.some((titulo) => typeof titulo !== "string" || !titulo.trim() || titulo.length > 1000)) {
    throw new Error("Lote de manchetes inválido.");
  }

  const response = await fetch(API_LOTE, {
    ...opcoesFetch(),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ titulos }),
  });

  if (!response.ok) {
    throw new Error(`API retornou ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.resultados) || data.resultados.length !== titulos.length ||
      data.resultados.some((r) => !r || ![0, 1].includes(r.clickbait_label_bot) ||
        typeof r.probabilidade_clickbait !== "number" ||
        r.probabilidade_clickbait < 0 || r.probabilidade_clickbait > 1)) {
    throw new Error("Resposta inválida da API.");
  }
  return data.resultados;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "CLASSIFY_BATCH") {
    const geracao = geracaoStats;
    classificarLote(request.titulos)
      .then(async (resultados) => {
        await atualizarContadores(resultados, geracao);
        sendResponse({ success: true, resultados });
      })
      .catch((err) => {
        console.warn("[Clickbait Detector] Erro ao classificar:", err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.type === "CHECK_HEALTH") {
    fetch(API_HEALTH, opcoesFetch())
      .then(async (response) => {
        if (!response.ok) throw new Error("API indisponível");
        const data = await response.json();
        sendResponse({ online: data?.status === "ok", data });
      })
      .catch(() => sendResponse({ online: false }));
    return true;
  }

  if (request.type === "GET_STATS") {
    enfileirarStats(lerStats)
      .then(sendResponse)
      .catch((err) => sendResponse({ ...STATS_DEFAULT, error: err.message }));
    return true;
  }

  if (request.type === "RESET_STATS") {
    geracaoStats += 1;
    enfileirarStats(() => gravarStats(STATS_DEFAULT))
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
