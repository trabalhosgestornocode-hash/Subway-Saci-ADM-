// Blocos de UI reutilizados pelas views do Painel SuperAdmin.
//
// Existe para que as dez telas do painel compartilhem o MESMO vocabulário
// visual: um KPI é sempre o mesmo KPI, uma tabela é sempre a mesma tabela.
// Sem isso, dez views escritas em sequência divergem em detalhes e o painel
// deixa de parecer um produto só.
//
// Todo texto vindo do servidor passa por `escapeHtml` — as views montam HTML
// com template string, então escapar é obrigatório, não opcional.

import { el, escapeHtml, fmtMoeda, fmtDataHora, fmtRelativo } from "./utils.js";

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** Número com separador pt-BR. `null` (dado indisponível) vira "—". */
export function num(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR") : "—";
}

export function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1).replace(".", ",")}%` : "—";
}

export { escapeHtml, fmtMoeda, fmtDataHora, fmtRelativo };

/** Status de empresa -> classe de pill + rótulo. */
export const STATUS_EMPRESA = {
  ativa: { classe: "ok", rotulo: "Ativa" },
  teste: { classe: "info", rotulo: "Em teste" },
  bloqueada: { classe: "bad", rotulo: "Bloqueada" },
  suspensa: { classe: "warn", rotulo: "Suspensa" },
  cancelada: { classe: "muted", rotulo: "Cancelada" },
};

export const STATUS_ASSINATURA = {
  trial: { classe: "info", rotulo: "Teste" },
  ativa: { classe: "ok", rotulo: "Ativa" },
  inadimplente: { classe: "bad", rotulo: "Inadimplente" },
  cancelada: { classe: "muted", rotulo: "Cancelada" },
};

export const STATUS_COBRANCA = {
  pendente: { classe: "warn", rotulo: "Pendente" },
  paga: { classe: "ok", rotulo: "Paga" },
  vencida: { classe: "bad", rotulo: "Vencida" },
  cancelada: { classe: "muted", rotulo: "Cancelada" },
  estornada: { classe: "muted", rotulo: "Estornada" },
};

/** Situação de item monitorado. */
export const SITUACAO = {
  operacional: { classe: "ok", rotulo: "Operacional" },
  degradado: { classe: "warn", rotulo: "Degradado" },
  falha: { classe: "bad", rotulo: "Falha" },
  desligado: { classe: "muted", rotulo: "Desligado" },
  sem_sonda: { classe: "info", rotulo: "Sem monitoramento" },
};

/** @param {Record<string, {classe: string, rotulo: string}>} mapa @param {string} valor */
export function pill(mapa, valor) {
  const m = mapa[valor] ?? { classe: "muted", rotulo: valor ?? "—" };
  return `<span class="pill ${m.classe}">${escapeHtml(m.rotulo)}</span>`;
}

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

/**
 * Cartão de indicador. `sub` é o rodapé explicativo; `indisponivel` marca o
 * cartão como "sem fonte de dado" em vez de mostrar zero — zero e "não sei"
 * são coisas diferentes, e confundi-las num painel de administração leva a
 * decisão errada.
 * @param {{label: string, valor: string|number, sub?: string, tom?: string, indisponivel?: {origem: string}}} o
 */
export function kpi({ label, valor, sub, tom = "", indisponivel = null }) {
  if (indisponivel) {
    return `
      <div class="adm-kpi adm-kpi--vazio">
        <span class="adm-kpi-label">${escapeHtml(label)}</span>
        <span class="adm-kpi-valor">—</span>
        <span class="adm-kpi-sub">Sem fonte: ${escapeHtml(indisponivel.origem)}</span>
      </div>`;
  }
  return `
    <div class="adm-kpi ${tom ? `adm-kpi--${tom}` : ""}">
      <span class="adm-kpi-label">${escapeHtml(label)}</span>
      <span class="adm-kpi-valor">${escapeHtml(String(valor))}</span>
      ${sub ? `<span class="adm-kpi-sub">${escapeHtml(sub)}</span>` : ""}
    </div>`;
}

/** @param {string} html */
export const kpiGrade = (html) => `<div class="adm-kpis">${html}</div>`;

/**
 * Seção com título, ações opcionais e corpo.
 * @param {{titulo: string, acoes?: string, corpo: string, nota?: string}} o
 */
export function secao({ titulo, acoes = "", corpo, nota = "" }) {
  return `
    <section class="adm-secao">
      <header class="adm-secao-head">
        <h2>${escapeHtml(titulo)}</h2>
        ${acoes ? `<div class="adm-secao-acoes">${acoes}</div>` : ""}
      </header>
      ${nota ? `<p class="adm-nota">${escapeHtml(nota)}</p>` : ""}
      <div class="adm-secao-body">${corpo}</div>
    </section>`;
}

/**
 * Tabela. `colunas` são rótulos; `linhas` são arrays de HTML JÁ ESCAPADO pelo
 * chamador (as células frequentemente contêm pills e botões, então escapar
 * aqui quebraria a marcação).
 * @param {{colunas: string[], linhas: string[][], vazio?: string}} o
 */
export function tabela({ colunas, linhas, vazio = "Nenhum registro." }) {
  if (!linhas.length) return `<div class="estado-mini">${escapeHtml(vazio)}</div>`;
  return `
    <div class="adm-tabela-wrap">
      <table class="adm-tabela">
        <thead><tr>${colunas.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

export const carregando = (msg = "Carregando…") =>
  `<div class="estado"><div class="spinner"></div>${escapeHtml(msg)}</div>`;

export const erro = (msg) =>
  `<div class="estado erro"><span class="emoji">⚠️</span><h3>Não foi possível carregar</h3><p>${escapeHtml(msg)}</p></div>`;

export const vazio = (titulo, texto = "") =>
  `<div class="estado"><span class="emoji">📭</span><h3>${escapeHtml(titulo)}</h3>${texto ? `<p>${escapeHtml(texto)}</p>` : ""}</div>`;

/**
 * Aviso de recurso ainda sem implementação, com o que falta para habilitá-lo.
 * Preferível a um botão que não faz nada: o operador sabe o que existe e o que
 * não existe.
 * @param {string} titulo @param {string} porque
 */
export const reservado = (titulo, porque) => `
  <div class="adm-reservado">
    <span class="adm-reservado-ic">🧱</span>
    <div>
      <b>${escapeHtml(titulo)}</b>
      <p>${escapeHtml(porque)}</p>
    </div>
  </div>`;

/**
 * Gráfico de barras em SVG puro (sem dependência). O Chart.js do app existe,
 * mas para uma série mensal simples ele é peso desnecessário — e SVG inline
 * herda o tema automaticamente.
 * @param {Array<{mes: string, total: number}>} serie
 * @param {string} rotulo
 */
export function barras(serie, rotulo = "") {
  if (!serie?.length) return `<div class="estado-mini">Sem dados no período.</div>`;
  const max = Math.max(...serie.map((p) => p.total), 1);
  const L = 34, alturaMax = 96;
  const largura = serie.length * L;
  const barras = serie.map((p, i) => {
    const h = Math.max(Math.round((p.total / max) * alturaMax), p.total > 0 ? 3 : 1);
    const rotuloMes = p.mes.slice(5) + "/" + p.mes.slice(2, 4);
    return `
      <g transform="translate(${i * L},0)">
        <rect x="6" y="${alturaMax - h}" width="${L - 12}" height="${h}" rx="4" class="adm-barra">
          <title>${escapeHtml(rotuloMes)}: ${p.total}</title>
        </rect>
        <text x="${L / 2}" y="${alturaMax + 14}" class="adm-barra-lbl">${escapeHtml(rotuloMes)}</text>
        ${p.total > 0 ? `<text x="${L / 2}" y="${alturaMax - h - 4}" class="adm-barra-val">${p.total}</text>` : ""}
      </g>`;
  }).join("");
  return `
    <div class="adm-grafico">
      ${rotulo ? `<span class="adm-grafico-lbl">${escapeHtml(rotulo)}</span>` : ""}
      <svg viewBox="0 0 ${largura} ${alturaMax + 20}" preserveAspectRatio="xMidYMax meet" role="img"
           aria-label="${escapeHtml(rotulo)}">${barras}</svg>
    </div>`;
}

// ---------------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------------

/**
 * @param {{id: string, label: string, valor?: unknown, tipo?: string, ph?: string, dica?: string, obrigatorio?: boolean}} o
 */
export function campo({ id, label, valor = "", tipo = "text", ph = "", dica = "", obrigatorio = false }) {
  return `
    <label class="adm-campo">
      <span>${escapeHtml(label)}${obrigatorio ? ' <em class="req">*</em>' : ""}</span>
      <input id="${id}" type="${tipo}" placeholder="${escapeHtml(ph)}" value="${escapeHtml(valor ?? "")}" />
      ${dica ? `<small>${escapeHtml(dica)}</small>` : ""}
    </label>`;
}

/**
 * @param {{id: string, label: string, opcoes: Array<{valor: string, rotulo: string}>, valor?: string, dica?: string, vazio?: string}} o
 */
export function selecao({ id, label, opcoes, valor = "", dica = "", vazio = "" }) {
  return `
    <label class="adm-campo">
      <span>${escapeHtml(label)}</span>
      <select id="${id}">
        ${vazio ? `<option value="">${escapeHtml(vazio)}</option>` : ""}
        ${opcoes.map((o) => `<option value="${escapeHtml(o.valor)}" ${o.valor === valor ? "selected" : ""}>${escapeHtml(o.rotulo)}</option>`).join("")}
      </select>
      ${dica ? `<small>${escapeHtml(dica)}</small>` : ""}
    </label>`;
}

/** @param {{id: string, label: string, valor?: string, linhas?: number}} o */
export function area({ id, label, valor = "", linhas = 3 }) {
  return `
    <label class="adm-campo adm-campo--full">
      <span>${escapeHtml(label)}</span>
      <textarea id="${id}" rows="${linhas}">${escapeHtml(valor ?? "")}</textarea>
    </label>`;
}

/** @param {string} html */
export const grade = (html) => `<div class="adm-form-grade">${html}</div>`;

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

let aoConfirmarAtual = null;

/**
 * Abre o modal do painel.
 * @param {{titulo: string, corpo: string, confirmar?: string, aoConfirmar?: () => Promise<unknown>|unknown, perigo?: boolean}} o
 */
export function abrirModal({ titulo, corpo, confirmar = "Salvar", aoConfirmar = null, perigo = false }) {
  el("#adm-modal-titulo").textContent = titulo;
  el("#adm-modal-body").innerHTML = corpo;
  aoConfirmarAtual = aoConfirmar;
  el("#adm-modal-foot").innerHTML = aoConfirmar
    ? `<button class="btn btn-ghost" data-fechar-modal>Cancelar</button>
       <button class="btn ${perigo ? "btn-perigo" : "btn-primary"}" id="adm-modal-ok">${escapeHtml(confirmar)}</button>`
    : `<button class="btn btn-ghost" data-fechar-modal>Fechar</button>`;
  el("#adm-modal").hidden = false;

  const ok = el("#adm-modal-ok");
  if (ok) {
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      const original = ok.textContent;
      ok.textContent = "Aguarde…";
      try {
        // Só fecha se a ação deu certo. Fechar antes esconderia o erro de
        // validação exatamente quando o usuário precisa lê-lo.
        await aoConfirmarAtual?.();
        fecharModal();
      } catch (e) {
        mostrarErroModal(e.message);
        ok.disabled = false;
        ok.textContent = original;
      }
    });
  }
}

export function fecharModal() {
  el("#adm-modal").hidden = true;
  el("#adm-modal-body").innerHTML = "";
  el("#adm-modal-foot").innerHTML = "";
  aoConfirmarAtual = null;
}

export function mostrarErroModal(msg) {
  let box = el("#adm-modal-erro");
  if (!box) {
    box = document.createElement("div");
    box.id = "adm-modal-erro";
    box.className = "lg-erro";
    el("#adm-modal-body").prepend(box);
  }
  box.textContent = msg;
  box.hidden = false;
}

/** Lê o valor de um campo do modal (ou de qualquer container). */
export const valor = (id) => (el(`#${id}`)?.value ?? "").trim();
export const marcado = (id) => !!el(`#${id}`)?.checked;

// Fechar pelo backdrop, pelo X e pelo Esc.
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-fechar-modal]")) fecharModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("#adm-modal")?.hidden) fecharModal();
});
