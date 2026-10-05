// Content script — encontra manchetes, consulta a API via Service Worker e aplica badges.

(function () {
  "use strict";

  const SELETORES = [
    "h1", "h2", "h3", "h4",
    "article h4",
    "[class*='headline__title']",
    "[class*='headline-title']",
    "[class*='headline_title']",
    "[class*='c-headline__title']",
    "[class*='news-title']",
    "[class*='entry-title']",
    "[class*='post-title']",
    "[class*='noticia__title']",
    "[class*='title__element']",
    ".feed-post-link",
    ".feed-post-body-title",
    ".chamada > a",
    "a[class*='headline']",
    "a[class*='title']",
  ].join(",");

  const ATTR_CHECKED = "data-cb-checked";
  const BATCH_SIZE = 50;
  const RETRY_DELAYS = [2000, 5000, 10000];
  const MIN_CHARS = 20;
  const MAX_CHARS = 350;
  const MIN_WORDS = 3;

  const classificados = new WeakMap();
  const badges = new WeakMap();
  const pendentes = new WeakSet();
  const bloqueados = new WeakMap();
  let ultimaFalha = false;
  let emAndamento = null;
  let debounceTimer = null;
  let retryTimer = null;
  let falhas = 0;
  let aguardandoRetry = false;

  function limparTexto(el) {
    if (!el) return "";
    // Se o elemento contiver badges próprios, clona e remove antes de extrair o texto
    const badgesInternos = el.querySelectorAll?.(".cb-badge, .cb-badge-wrapper");
    if (badgesInternos && badgesInternos.length > 0) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(".cb-badge, .cb-badge-wrapper").forEach((b) => b.remove());
      return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    }
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function tipoCandidato(el) {
    // 1. Descarta elementos em áreas de navegação, rodapés, barras laterais de menu e badges
    if (el.closest("nav, footer, aside, [role='navigation'], [role='banner'], .cb-badge, .cb-badge-wrapper")) {
      return false;
    }

    // 2. Descarta cabeçalho principal de navegação do site (mas permite cabeçalhos de notícias/artigos)
    const header = el.closest("header");
    if (header && (header.querySelector?.("nav") || header.className?.includes("site-header") || header.className?.includes("main-header"))) {
      if (!el.closest("article, [class*='post'], [class*='feed'], [class*='materia']")) {
        return false;
      }
    }

    // 3. Descarta chapéus / kickers / retrancas / editorias (ex: "INFRAESTRUTURA", "OPINIÃO", "ELEIÇÕES 2026")
    if (el.closest("[class*='kicker'], [class*='chapeu'], [class*='chapéu'], [class*='retranca'], [class*='rubrica'], [class*='editoria'], .c-headline__head")) {
      return false;
    }

    // 4. Descarta subtítulos / linhas finas / resumos / standfirsts
    if (el.closest("[class*='standfirst'], [class*='subtitle'], [class*='subtitulo'], [class*='sub-title'], [class*='linha-fina'], [class*='linhafina'], [class*='resumo'], [itemprop='alternativeHeadline']")) {
      return false;
    }

    // 5. Descarta ferramentas de compartilhamento, botões, ações e modais
    if (el.closest(".c-tools-share, [class*='share'], [class*='action'], [class*='modal'], [class*='toolbar'], button")) {
      return false;
    }

    // 6. Descarta metadados de autoria, data ou copyright
    if (el.closest("[itemprop~='author'], [rel~='author'], .byline, .autor, .date, .data, time, [class*='copyright']")) {
      return false;
    }

    // 7. Descarta elementos ocultos
    if (el.offsetParent === null && el.tagName !== "BODY") {
      return false;
    }

    return true;
  }

  function extrairNovos(forcar = false) {
    const nos = [];
    const textos = [];
    const candidatos = Array.from(document.querySelectorAll(SELETORES));

    for (const el of candidatos) {
      // Ignora o próprio badge
      if (el.classList?.contains("cb-badge") || el.closest?.(".cb-badge, .cb-badge-wrapper")) {
        continue;
      }

      // Se não for forçado e já foi verificado, pula para nunca reprocessar o mesmo elemento
      if (!forcar && el.hasAttribute(ATTR_CHECKED)) {
        continue;
      }

      if (!tipoCandidato(el)) continue;

      const textoAtual = limparTexto(el);

      if (forcar) {
        removerBadge(el);
        classificados.delete(el);
        bloqueados.delete(el);
        el.removeAttribute(ATTR_CHECKED);
      }

      // Deduplicação: se um elemento contém ou é contido por outro candidato:
      // Ex: <h2><a href="...">Título</a></h2>
      // Mantemos o elemento H1-H4 e descartamos o link interno ou container externo
      const isHeading = /^H[1-4]$/.test(el.tagName);

      if (!isHeading && candidatos.some((outro) => outro !== el && (outro.contains(el) || el.contains(outro)) && /^H[1-4]$/.test(outro.tagName) && tipoCandidato(outro))) {
        continue;
      }

      // Se ambos são headings (ex: h3 dentro de h2) e o outro é mais interno, ignora o externo
      if (isHeading && candidatos.some((outro) => outro !== el && /^H[1-4]$/.test(outro.tagName) && el.contains(outro) && tipoCandidato(outro))) {
        continue;
      }

      // Se nenhum é heading e o elemento contém outro candidato, ignora o container pai
      if (!isHeading && candidatos.some((outro) => outro !== el && el.contains(outro) && tipoCandidato(outro))) {
        continue;
      }

      if (textoAtual.length < MIN_CHARS || textoAtual.length > MAX_CHARS ||
          textoAtual.split(/\s+/).length < MIN_WORDS) {
        continue;
      }

      if (pendentes.has(el) || (!forcar &&
          (classificados.get(el) === textoAtual || bloqueados.get(el) === textoAtual))) {
        continue;
      }

      nos.push(el);
      textos.push(textoAtual);
    }
    return { nos, textos };
  }

  function removerBadge(el) {
    const badge = badges.get(el);
    if (badge) badge.remove();
    badges.delete(el);
    el.querySelectorAll?.(".cb-badge, .cb-badge-wrapper").forEach((b) => b.remove());
    el.removeAttribute(ATTR_CHECKED);
  }

  function aplicarBadge(el, resultado) {
    if (!el.isConnected) return;
    removerBadge(el);

    const isClickbait = resultado.clickbait_label_bot === 1;
    const pct = (resultado.probabilidade_clickbait * 100).toFixed(1);
    const confianca = isClickbait ? pct : (100 - parseFloat(pct)).toFixed(1);

    const badge = document.createElement("span");
    badge.className = isClickbait ? "cb-badge cb-sim" : "cb-badge cb-nao";
    badge.title = isClickbait
      ? `Provável clickbait — confiança: ${pct}%`
      : `Notícia legítima — confiança: ${confianca}%`;
    badge.textContent = isClickbait ? `⚠️ Clickbait (${pct}%)` : "✓ Legítima";

    // Inserção inline como primeiro filho do elemento (mantém estilo fluído)
    try {
      el.insertBefore(badge, el.firstChild);
    } catch (_) {
      if (el.parentElement) {
        el.parentElement.insertBefore(badge, el);
      }
    }
    badges.set(el, badge);
  }

  function agendarRetry() {
    if (retryTimer !== null || falhas > RETRY_DELAYS.length) return;
    const atraso = RETRY_DELAYS[falhas - 1];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      aguardandoRetry = false;
      classificar();
    }, atraso);
  }

  async function executarVarredura(forcar) {
    const { nos, textos } = extrairNovos(forcar);
    if (textos.length === 0) return { success: true, total: 0 };

    // Marca imediatamente como pendentes e checados para impedir qualquer reprocessamento em loops
    nos.forEach((el) => {
      pendentes.add(el);
      el.setAttribute(ATTR_CHECKED, "1");
    });

    let total = 0;
    let erro = null;
    const falharam = new Set();

    for (let i = 0; i < textos.length; i += BATCH_SIZE) {
      const loteNos = nos.slice(i, i + BATCH_SIZE);
      const loteTitulos = textos.slice(i, i + BATCH_SIZE);
      try {
        const resposta = await chrome.runtime.sendMessage({
          type: "CLASSIFY_BATCH",
          titulos: loteTitulos,
        });
        if (!resposta?.success || !Array.isArray(resposta.resultados) ||
            resposta.resultados.length !== loteTitulos.length) {
          throw new Error(resposta?.error || "Resposta inválida da API");
        }
        resposta.resultados.forEach((resultado, idx) => {
          const el = loteNos[idx];
          if (!el.isConnected) return;
          aplicarBadge(el, resultado);
          classificados.set(el, loteTitulos[idx]);
          bloqueados.delete(el);
          total += 1;
        });
      } catch (err) {
        erro = err.message;
        loteNos.forEach((el) => {
          falharam.add(el);
          el.removeAttribute(ATTR_CHECKED);
        });
        console.warn("[Clickbait Detector] Erro na classificação:", erro);
      } finally {
        loteNos.forEach((el) => pendentes.delete(el));
      }
    }

    if (erro) {
      falhas += 1;
      ultimaFalha = true;
      aguardandoRetry = falhas <= RETRY_DELAYS.length;
      if (!aguardandoRetry) {
        nos.forEach((el, idx) => {
          if (falharam.has(el)) bloqueados.set(el, textos[idx]);
        });
      }
      agendarRetry();
    } else {
      falhas = 0;
      ultimaFalha = false;
      aguardandoRetry = false;
    }

    return erro ? { success: false, error: erro, total } : { success: true, total };
  }

  async function classificar(forcar = false) {
    if (forcar) {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      aguardandoRetry = false;
      falhas = 0;
      ultimaFalha = false;
    }

    if (emAndamento) {
      if (forcar) await emAndamento;
      else return emAndamento;
    }

    if (aguardandoRetry && !forcar) return { success: false, error: "Aguardando nova tentativa" };

    const tarefa = executarVarredura(forcar);
    emAndamento = tarefa;
    try {
      return await tarefa;
    } finally {
      if (emAndamento === tarefa) emAndamento = null;
    }
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type !== "RECHECK_PAGE") return;
    classificar(true)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  });

  const observer = new MutationObserver((mutations) => {
    // 1. Limpa registros de elementos que foram realmente removidos do DOM
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes || []) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains("cb-badge") || node.classList?.contains("cb-badge-wrapper")) {
          continue;
        }
        const removidos = [node, ...(node.querySelectorAll ? node.querySelectorAll(SELETORES) : [])];
        for (const el of removidos) {
          const badge = badges.get(el);
          if (badge) {
            removerBadge(el);
            classificados.delete(el);
          }
        }
      }
    }

    // 2. Ignora mutações geradas exclusivamente por nossos próprios badges
    if (mutations.length && mutations.every((mutation) => {
      const alvo = mutation.target?.nodeType === 3 ? mutation.target.parentElement : mutation.target;
      if (alvo?.closest?.(".cb-badge, .cb-badge-wrapper")) return true;
      return mutation.type === "childList" &&
        [...mutation.addedNodes, ...mutation.removedNodes].every((node) =>
          node.nodeType === 1 && (node.classList?.contains("cb-badge") || node.classList?.contains("cb-badge-wrapper")));
    })) return;

    if (aguardandoRetry) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => classificar(), 800);
  });

  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  classificar();
})();
