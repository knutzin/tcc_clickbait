/**
 * content_script.js — Content Script
 *
 * Executado em todas as páginas após o carregamento do DOM.
 *
 * Responsabilidades:
 *  1. Varrer o DOM em busca de manchetes (h1–h3, elementos com classes semânticas)
 *  2. Enviar lotes para o Service Worker para classificação
 *  3. Aplicar badges visuais inline em cada manchete
 *  4. Observar mudanças no DOM para cobrir SPAs e infinite scroll
 */

(function () {
  "use strict";

  // ─── Configuração ────────────────────────────────────────────────────────────

  /** Seletores CSS para identificar manchetes na página */
  const SELETORES = [
    "h1", "h2", "h3",
    "article h4",
    "[class*='headline']",
    "[class*='title']",
    "[class*='noticia']",
    "[class*='news-title']",
    "[class*='entry-title']",
    "[class*='post-title']",
    ".chamada > a",
    ".feed-post-link",
  ].join(",");

  /** Tamanho mínimo do texto para ser considerado manchete */
  const MIN_CHARS = 20;

  /** Tamanho máximo do lote enviado por vez à API */
  const BATCH_SIZE = 50;

  /** Atributo de marcação para não processar o mesmo elemento duas vezes */
  const ATTR_CHECKED = "data-cb-checked";

  // ─── Extração de manchetes ───────────────────────────────────────────────────

  /**
   * Remove elementos ancestrais quando um descendente também está na lista.
   * Isso evita badges duplicados quando um <h2 class="title"> casa com
   * ambos os seletores "h2" e "[class*='title']".
   * Mantém sempre o elemento mais específico (mais profundo na árvore).
   * @param {Element[]} elementos
   * @returns {Element[]}
   */
  function deduplicarPorAncestral(elementos) {
    return elementos.filter(
      (el) => !elementos.some((outro) => outro !== el && el.contains(outro))
    );
  }

  /**
   * Varre o DOM e retorna apenas os elementos ainda não verificados.
   * @returns {{ nos: Element[], textos: string[] }}
   */
  function extrairNovos() {
    const nos = [];
    const textos = [];

    // Coleta todos os candidatos sem duplicatas do querySelectorAll
    const candidatos = Array.from(document.querySelectorAll(SELETORES));

    // Remove elementos que contêm outro elemento da lista (mantém o mais profundo)
    const semAncestores = deduplicarPorAncestral(candidatos);

    semAncestores.forEach((el) => {
      // Ignora elementos já processados, invisíveis ou dentro de badges
      if (
        el.hasAttribute(ATTR_CHECKED) ||
        el.closest(".cb-badge") ||
        el.offsetParent === null
      ) {
        return;
      }

      const texto = (el.innerText || el.textContent || "").trim();
      if (texto.length >= MIN_CHARS) {
        el.setAttribute(ATTR_CHECKED, "1");
        nos.push(el);
        textos.push(texto);
      }
    });

    return { nos, textos };
  }

  // ─── Aplicação de badges ─────────────────────────────────────────────────────

  /**
   * Insere um badge visual na manchete.
   * Tenta inline primeiro; se o elemento não tiver pai visível, usa um wrapper div.
   * @param {Element} el
   * @param {{ clickbait_label_bot: number, probabilidade_clickbait: number }} resultado
   */
  function aplicarBadge(el, resultado) {
    const isClickbait = resultado.clickbait_label_bot === 1;
    const pct = (resultado.probabilidade_clickbait * 100).toFixed(1);
    const confianca = isClickbait ? pct : (100 - parseFloat(pct)).toFixed(1);

    const badge = document.createElement("span");
    badge.className = isClickbait ? "cb-badge cb-sim" : "cb-badge cb-nao";
    badge.title = isClickbait
      ? `Provável clickbait — confiança: ${pct}%`
      : `Notícia legítima — confiança: ${confianca}%`;
    badge.textContent = isClickbait ? `⚠️ Clickbait (${pct}%)` : `✓ Legítima`;

    // Estratégia 1: insere inline antes do primeiro filho (comportamento padrão)
    try {
      el.insertBefore(badge, el.firstChild);
      return;
    } catch (_) {
      // fallback abaixo
    }

    // Estratégia 2: insere um wrapper div antes do elemento no pai
    const wrapper = document.createElement("div");
    wrapper.className = "cb-badge-wrapper";
    wrapper.appendChild(badge);
    const parent = el.parentElement;
    if (parent) {
      parent.insertBefore(wrapper, el);
    }
  }

  // ─── Classificação ───────────────────────────────────────────────────────────

  /** Flag para evitar chamadas simultâneas enquanto uma já está em progresso */
  let emAndamento = false;

  /**
   * Extrai manchetes novas e as envia em lotes para o Service Worker.
   */
  async function classificar() {
    if (emAndamento) return;
    emAndamento = true;

    try {
      const { nos, textos } = extrairNovos();
      if (textos.length === 0) return;

      // Envia em lotes para não sobrecarregar a API
      for (let i = 0; i < textos.length; i += BATCH_SIZE) {
        const loteNos = nos.slice(i, i + BATCH_SIZE);
        const loteTitulos = textos.slice(i, i + BATCH_SIZE);

        const resposta = await chrome.runtime.sendMessage({
          type: "CLASSIFY_BATCH",
          titulos: loteTitulos,
        });

        if (resposta?.success) {
          resposta.resultados.forEach((resultado, idx) => {
            aplicarBadge(loteNos[idx], resultado);
          });
        } else {
          // Marca os elementos como verificados mesmo com erro para não retentar em loop
          console.warn(
            "[Clickbait Detector] Erro na classificação:",
            resposta?.error
          );
        }
      }
    } finally {
      emAndamento = false;
    }
  }

  // ─── Inicialização e MutationObserver ────────────────────────────────────────

  // Roda na carga inicial
  classificar();

  // Observa mudanças no DOM para cobrir SPAs e infinite scroll
  // Usa debounce para evitar chamadas excessivas
  let debounceTimer = null;

  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(classificar, 800);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
