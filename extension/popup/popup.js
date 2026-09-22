/**
 * popup.js — Lógica do popup da extensão
 *
 * Ao abrir o popup:
 *  1. Verifica o status da API via Service Worker
 *  2. Carrega os contadores do chrome.storage
 *  3. Habilita os botões de ação
 */

const elStatus      = document.getElementById("api-status");
const elTotal       = document.getElementById("stat-total");
const elClickbaits  = document.getElementById("stat-clickbaits");
const elPct         = document.getElementById("stat-pct");
const elOfflineTip  = document.getElementById("offline-tip");
const btnVerificar  = document.getElementById("btn-verificar");
const btnReset      = document.getElementById("btn-reset");

// ─── Inicialização ────────────────────────────────────────────────────────────

inicializar();

async function inicializar() {
  await Promise.all([verificarAPI(), carregarStats()]);
}

// ─── Status da API ────────────────────────────────────────────────────────────

async function verificarAPI() {
  const resposta = await chrome.runtime.sendMessage({ type: "CHECK_HEALTH" });

  if (resposta?.online) {
    elStatus.textContent = "🟢 Online";
    elStatus.className = "status-text status-online";
    elOfflineTip.style.display = "none";
    btnVerificar.disabled = false;
  } else {
    elStatus.textContent = "🔴 Offline";
    elStatus.className = "status-text status-offline";
    elOfflineTip.style.display = "block";
    btnVerificar.disabled = true;
  }
}

// ─── Estatísticas ─────────────────────────────────────────────────────────────

async function carregarStats() {
  const stats = await chrome.runtime.sendMessage({ type: "GET_STATS" });
  renderizarStats(stats);
}

function renderizarStats({ total, clickbaits }) {
  elTotal.textContent      = total;
  elClickbaits.textContent = clickbaits;
  elPct.textContent        = total > 0
    ? `${((clickbaits / total) * 100).toFixed(1)}%`
    : "—";
}

// ─── Botões ───────────────────────────────────────────────────────────────────

// Injeta o content script na aba atual e aciona a classificação
btnVerificar.addEventListener("click", async () => {
  btnVerificar.disabled = true;
  btnVerificar.textContent = "Verificando…";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Injeta o script para forçar uma nova varredura
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Remove a marcação dos elementos já verificados para forçar nova rodada
      document.querySelectorAll("[data-cb-checked]").forEach((el) => {
        el.removeAttribute("data-cb-checked");
      });
      document.querySelectorAll(".cb-badge").forEach((b) => b.remove());
    },
  });

  // Aguarda o content script retomar via MutationObserver
  await new Promise((r) => setTimeout(r, 1200));
  await carregarStats();

  btnVerificar.disabled = false;
  btnVerificar.textContent = "▶ Verificar página agora";
});

// Zera os contadores
btnReset.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESET_STATS" });
  renderizarStats({ total: 0, clickbaits: 0 });
});
