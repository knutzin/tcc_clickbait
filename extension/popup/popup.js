// Popup — mostra saúde da API, contadores e permite verificar a página aberta.

const elStatus = document.getElementById("api-status");
const elTotal = document.getElementById("stat-total");
const elClickbaits = document.getElementById("stat-clickbaits");
const elPct = document.getElementById("stat-pct");
const elOfflineTip = document.getElementById("offline-tip");
const btnVerificar = document.getElementById("btn-verificar");
const btnReset = document.getElementById("btn-reset");
let statusGeneration = 0;

function mostrarErro(mensagem) {
  statusGeneration += 1;
  elStatus.textContent = `🔴 Falha: ${mensagem}`;
  elStatus.className = "status-text status-offline";
}

async function verificarAPI() {
  const generation = statusGeneration;
  try {
    const resposta = await chrome.runtime.sendMessage({ type: "CHECK_HEALTH" });
    if (generation !== statusGeneration) return;
    if (resposta?.online) {
      elStatus.textContent = "🟢 Online";
      elStatus.className = "status-text status-online";
      elOfflineTip.style.display = "none";
    } else {
      elStatus.textContent = "🔴 Offline";
      elStatus.className = "status-text status-offline";
      elOfflineTip.style.display = "block";
    }
  } catch (_) {
    if (generation !== statusGeneration) return;
    mostrarErro("não foi possível consultar a API");
    elOfflineTip.style.display = "block";
  }
}

function renderizarStats({ total, clickbaits }) {
  elTotal.textContent = total;
  elClickbaits.textContent = clickbaits;
  elPct.textContent = total > 0
    ? `${((clickbaits / total) * 100).toFixed(1)}%`
    : "—";
}

async function carregarStats() {
  try {
    const stats = await chrome.runtime.sendMessage({ type: "GET_STATS" });
    if (stats?.error) throw new Error(stats.error);
    renderizarStats(stats);
  } catch (_) {
    mostrarErro("não foi possível ler os contadores");
  }
}

verificarAPI();
carregarStats();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.total || changes.clickbaits)) carregarStats();
});

btnVerificar.addEventListener("click", async () => {
  statusGeneration += 1;
  btnVerificar.disabled = true;
  btnVerificar.textContent = "Verificando…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("nenhuma página disponível");
    const resposta = await chrome.tabs.sendMessage(tab.id, { type: "RECHECK_PAGE" });
    if (!resposta?.success) throw new Error(resposta?.error || "não foi possível verificar a página");
    await carregarStats();
    await verificarAPI();
  } catch (_) {
    mostrarErro("não foi possível verificar esta página");
  } finally {
    btnVerificar.disabled = false;
    btnVerificar.textContent = "▶ Verificar página agora";
  }
});

btnReset.addEventListener("click", async () => {
  btnReset.disabled = true;
  try {
    const resposta = await chrome.runtime.sendMessage({ type: "RESET_STATS" });
    if (!resposta?.success) throw new Error(resposta?.error || "falha ao zerar");
    await carregarStats();
  } catch (_) {
    mostrarErro("não foi possível zerar os contadores");
  } finally {
    btnReset.disabled = false;
  }
});
