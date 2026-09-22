/**
 * service_worker.js — Background Service Worker (Manifest V3)
 *
 * Responsabilidades:
 *  1. Receber lotes de manchetes do Content Script via chrome.runtime.sendMessage
 *  2. Enviar POST para a API FastAPI local em localhost:8000
 *  3. Devolver os resultados ao Content Script
 *  4. Manter contadores globais (total verificado / total clickbait) no chrome.storage
 */

const API_BASE = "http://localhost:8000";
const API_LOTE = `${API_BASE}/classificar-lote`;
const API_HEALTH = `${API_BASE}/health`;

// ─── Listener principal ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  // Classifica um lote de manchetes
  if (request.type === "CLASSIFY_BATCH") {
    classificarLote(request.titulos)
      .then((resultados) => {
        atualizarContadores(resultados);
        sendResponse({ success: true, resultados });
      })
      .catch((err) => {
        console.warn("[Clickbait Detector] Erro ao classificar:", err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true; // mantém o canal aberto para a resposta assíncrona
  }

  // Verifica se a API está no ar (usado pelo popup)
  if (request.type === "CHECK_HEALTH") {
    fetch(API_HEALTH)
      .then((r) => r.json())
      .then((data) => sendResponse({ online: true, data }))
      .catch(() => sendResponse({ online: false }));
    return true;
  }

  // Retorna os contadores armazenados (usado pelo popup)
  if (request.type === "GET_STATS") {
    chrome.storage.local.get({ total: 0, clickbaits: 0 }, (stats) => {
      sendResponse(stats);
    });
    return true;
  }

  // Zera os contadores (usado pelo popup)
  if (request.type === "RESET_STATS") {
    chrome.storage.local.set({ total: 0, clickbaits: 0 }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// ─── Funções auxiliares ───────────────────────────────────────────────────────

/**
 * Envia um lote de manchetes para a API e retorna os resultados.
 * @param {string[]} titulos
 * @returns {Promise<object[]>}
 */
async function classificarLote(titulos) {
  const response = await fetch(API_LOTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ titulos }),
  });

  if (!response.ok) {
    const texto = await response.text();
    throw new Error(`API retornou ${response.status}: ${texto}`);
  }

  const data = await response.json();
  return data.resultados;
}

/**
 * Incrementa os contadores de manchetes verificadas e clickbaits detectados.
 * @param {object[]} resultados
 */
function atualizarContadores(resultados) {
  const novosClickbaits = resultados.filter(
    (r) => r.clickbait_label_bot === 1
  ).length;

  chrome.storage.local.get({ total: 0, clickbaits: 0 }, (stats) => {
    chrome.storage.local.set({
      total: stats.total + resultados.length,
      clickbaits: stats.clickbaits + novosClickbaits,
    });
  });
}
