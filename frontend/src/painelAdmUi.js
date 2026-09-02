// Vocabulário visual do PAINEL ADMINISTRATIVO — central de acompanhamento.
//
// Deliberadamente SEPARADO do adminUi.js (Painel SuperAdmin): este ambiente é
// GERENCIAL, não técnico. Poucas cores, status claros, leitura rápida. Nenhum
// número inventado — `null` do backend vira "—", nunca 0 nem 0%.
//
// Todo texto vindo do servidor passa por `escapeHtml` (as views montam HTML
// por template string).

import { escapeHtml } from "./utils.js";

// ---------------------------------------------------------------------------
// Formatação — "não sei" (null) nunca vira número
// ---------------------------------------------------------------------------

/** Fração 0..1 → "94%". `null`/inválido → "—". */
export function fmtPct(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** Conformidade que pode não ter denominador — distingue "sem base" de 0%. */
export function fmtConformidade(taxa, { semBase = "Sem unidades elegíveis" } = {}) {
  if (taxa === null || taxa === undefined || taxa === "") return { texto: "—", nota: semBase, vazio: true };
  return { texto: fmtPct(taxa), nota: "", vazio: false };
}

export function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR") : "—";
}

/** "2026-09-14" → "14/09/2026". */
export function fmtData(iso) {
  if (!iso || typeof iso !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** "2026-09-14" → "14/09" (compacto para listas). */
export function fmtDataCurta(iso) {
  if (!iso || typeof iso !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
}

/** "2026-09" → "setembro/2026". */
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export function fmtMesLongo(mesIso) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesIso ?? ""));
  if (!m) return String(mesIso ?? "—");
  return `${MESES[Number(m[2]) - 1] ?? m[2]}/${m[1]}`;
}

/** Nº de dias pendentes → "3 dias" / "1 dia" / "" quando 0. */
export function fmtDiasPendentes(n) {
  const q = Number(n) || 0;
  if (q <= 0) return "";
  return `${q} dia${q > 1 ? "s" : ""}`;
}

// ---------------------------------------------------------------------------
// Dicionários de status — 3 tons só: crítico / atenção / positivo
// ---------------------------------------------------------------------------

/** rollup.status → { classe, rotulo }. */
export const CRITICIDADE = {
  critico: { classe: "critico", rotulo: "Crítico" },
  atencao: { classe: "atencao", rotulo: "Atenção" },
  em_dia: { classe: "ok", rotulo: "Em dia" },
};

/** d1.categoria (STATUS_DIA projetado) → { classe, rotulo }. */
export const CATEGORIA_D1 = {
  sequencia_bloqueada: { classe: "critico", rotulo: "Sequência bloqueada" },
  nao_realizado: { classe: "atencao", rotulo: "Não realizado" },
  em_preenchimento: { classe: "atencao", rotulo: "Em preenchimento" },
  concluido: { classe: "ok", rotulo: "Concluído" },
  nao_aplicavel: { classe: "muted", rotulo: "Não aplicável" },
};

/** Ordem fixa dos grupos da "Ação Necessária Hoje" (nunca por percentual). */
export const ORDEM_ACAO = ["sequencia_bloqueada", "nao_realizado", "em_preenchimento", "concluido"];

/** projetarDia → estado visual da célula do calendário. */
export function estadoDiaCalendario(dia) {
  if (!dia) return { classe: "vazio", rotulo: "—" };
  if (dia.painel === "NAO_APLICAVEL") {
    const motivo = dia.motivoNaoAplicavel;
    if (motivo === "futuro") return { classe: "futuro", rotulo: "Futuro" };
    if (motivo === "hoje") return { classe: "hoje", rotulo: "Hoje" };
    return { classe: "na", rotulo: "Não aplicável" };
  }
  if (dia.painel === "COMPLETO") return { classe: "concluido", rotulo: "Concluído" };
  if (dia.painel === "INCOMPLETO") return { classe: "em-preenchimento", rotulo: "Em preenchimento" };
  if (dia.bloqueada) return { classe: "bloqueado", rotulo: "Bloqueado" };
  return { classe: "nao-realizado", rotulo: "Não realizado" };
}

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

/** @param {{classe: string, rotulo: string}} m */
export const chip = (m) => `<span class="padm-chip padm-chip--${m?.classe ?? "muted"}">${escapeHtml(m?.rotulo ?? "—")}</span>`;

export const chipCriticidade = (status) => chip(CRITICIDADE[status] ?? { classe: "muted", rotulo: status ?? "—" });
export const chipCategoria = (cat) => chip(CATEGORIA_D1[cat] ?? { classe: "muted", rotulo: cat ?? "—" });

/**
 * Cartão de indicador. `tom` ∈ "", "critico", "atencao", "ok". `nota` explica
 * (ex.: "Sem unidades elegíveis" quando o valor é "—").
 * @param {{label: string, valor: string, nota?: string, tom?: string}} o
 */
export function card({ label, valor, nota = "", tom = "" }) {
  return `
    <div class="padm-card ${tom ? `padm-card--${tom}` : ""}">
      <span class="padm-card-label">${escapeHtml(label)}</span>
      <span class="padm-card-valor">${escapeHtml(String(valor))}</span>
      ${nota ? `<span class="padm-card-nota">${escapeHtml(nota)}</span>` : ""}
    </div>`;
}

export const cards = (html) => `<div class="padm-cards">${html}</div>`;

/** @param {{titulo: string, acoes?: string, corpo: string, sub?: string}} o */
export function secao({ titulo, acoes = "", corpo, sub = "" }) {
  return `
    <section class="padm-secao">
      <header class="padm-secao-head">
        <div>
          <h2>${escapeHtml(titulo)}</h2>
          ${sub ? `<p class="padm-secao-sub">${escapeHtml(sub)}</p>` : ""}
        </div>
        ${acoes ? `<div class="padm-secao-acoes">${acoes}</div>` : ""}
      </header>
      ${corpo}
    </section>`;
}

export const carregando = (msg = "Carregando…") =>
  `<div class="padm-estado"><span class="padm-spinner" aria-hidden="true"></span>${escapeHtml(msg)}</div>`;

/**
 * Erro. Distingue rede de "acesso revogado" — o 403 é tratado antes (volta
 * para a seleção de ambiente), então aqui a mensagem é sempre de falha de
 * carga, nunca de permissão.
 * @param {Error|string} e
 */
export function erro(e) {
  const msg = typeof e === "string" ? e : (e?.message || "Erro desconhecido.");
  const rede = /failed to fetch|networkerror|load failed|ECONN|fetch/i.test(msg);
  return `
    <div class="padm-estado padm-estado--erro">
      <span class="padm-estado-ic" aria-hidden="true">!</span>
      <h3>Não foi possível carregar</h3>
      <p>${escapeHtml(rede ? "Falha de conexão. Verifique a rede e tente novamente." : msg)}</p>
      <button class="btn btn-ghost btn-sm" data-padm-acao="recarregar">Tentar de novo</button>
    </div>`;
}

export const vazio = (titulo, texto = "") =>
  `<div class="padm-estado padm-estado--vazio">
     <span class="padm-estado-ic" aria-hidden="true">✓</span>
     <h3>${escapeHtml(titulo)}</h3>${texto ? `<p>${escapeHtml(texto)}</p>` : ""}
   </div>`;

/** Campo de busca client-side. */
export const busca = (id, ph = "Buscar empresa ou unidade…") =>
  `<label class="padm-busca">
     <input type="search" id="${id}" placeholder="${escapeHtml(ph)}" autocomplete="off" />
   </label>`;
