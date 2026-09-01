// PLANO DE AÇÃO do Dashboard iFood — renderização PURA (só string HTML, sem
// DOM/estado), extraída de dashboardExecutivo.js para ser testável em Node
// (mesmo espírito de dashboardExecutivo.diagnostico.js no backend).
//
// Consome o objeto `diagnostico` já classificado pelo backend
// (dashboardExecutivo.diagnostico.js): `resumo`, `acoes` (CRITICAL / WARNING /
// DATA_PENDING) e `manutencao` (HEALTHY). NUNCA recalcula nada — todos os
// valores derivados (diferença, impacto, objetivo) já vêm prontos; aqui só se
// formata e se omite o que for null/undefined.
//
// Hierarquia visual (ver pedido de reformulação):
//   1. Resumo da operação (compacto)
//   2. Prioridades agora        — CRITICAL, card completo
//   3. Acompanhar de perto      — WARNING, card intermediário
//   4. Manter o que funciona    — HEALTHY, card compacto + "Como manter"
//   5. Qualidade dos dados      — DATA_PENDING, card informativo
import { escapeHtml, fmtMoeda, fmtPct } from "./utils.js";
import { icon } from "./icons.js";

/** p.p. formatado — fonte única (também usada pelos cards/indicadores da tela). */
export const fmtPp = (v) => (v == null ? "—" : `${Number(v).toFixed(1)} p.p.`);

const CLASSE_TIPO = { CRITICAL: "alerta", WARNING: "atencao", HEALTHY: "forte", DATA_PENDING: "dados" };
const DOT_TIPO = { CRITICAL: "bad", WARNING: "warn", HEALTHY: "ok", DATA_PENDING: "muted" };
const BADGE_TIPO = {
  CRITICAL: { texto: "Prioridade", classe: "bad" },
  WARNING: { texto: "Acompanhar", classe: "warn" },
  HEALTHY: { texto: "Saudável", classe: "ok" },
  DATA_PENDING: { texto: "Dados pendentes", classe: "muted" },
};
const ESTADO_CLASSE = { CRITICO: "critico", ATENCAO: "atencao", SAUDAVEL: "saudavel", DADOS_INSUFICIENTES: "dados" };

const dot = (c) => `<span class="alerta-dot ${c}"></span>`;

/**
 * Ponto de atenção investigável pelo Agente: é `categoria`, exceto os dois
 * achados de categoria "dados" (dias_pendentes / detalhamento_financeiro_ausente),
 * onde o `diagnosticoId` estável é que casa com a whitelist do backend
 * (agente.pageContext.js#ATTENTION_POINTS). Um item sem correspondência não
 * ganha botão — nunca se inventa uma categoria.
 */
function attentionPointDe(item) {
  return item.categoria === "dados" ? item.diagnosticoId : item.categoria;
}

function ctaHtml(cta) {
  if (!cta) return "";
  if (cta.aba) return `<button class="btn btn-ghost btn-sm" data-cta-aba="${escapeHtml(cta.aba)}" type="button">${escapeHtml(cta.label)}</button>`;
  if (cta.expandir) return `<button class="btn btn-ghost btn-sm" data-cta-expandir type="button">${escapeHtml(cta.label)}</button>`;
  return "";
}

function objetivoHtml(obj) {
  if (!obj) return "";
  const partes = [];
  if (obj.proximo) partes.push(`<span><b>Próximo objetivo:</b> ${escapeHtml(obj.proximo)}</span>`);
  if (obj.ideal) partes.push(`<span><b>Objetivo ideal:</b> ${escapeHtml(obj.ideal)}</span>`);
  return partes.length ? `<p class="dex-acao-obj">${partes.join(" · ")}</p>` : "";
}

/** Linha de números do card — só o que existir. HEALTHY não mostra o limite. */
function numerosHtml(item) {
  const partes = [];
  if (item.situacao) partes.push(`<span>Atual <b>${escapeHtml(item.situacao)}</b></span>`);
  if (item.meta?.ideal != null) partes.push(`<span>Meta ideal <b>${fmtPct(item.meta.ideal)}</b></span>`);
  if (item.tipo !== "HEALTHY" && item.meta?.limite != null) partes.push(`<span>Limite <b>${fmtPct(item.meta.limite)}</b></span>`);
  if (item.diferenca?.pp != null) {
    const rot = item.tipo === "HEALTHY" ? "abaixo da meta ideal" : "acima da meta ideal";
    partes.push(`<span>${fmtPp(Math.abs(item.diferenca.pp))} ${rot}</span>`);
  }
  return partes.length ? `<div class="dex-acao-numeros">${partes.join("")}</div>` : "";
}

/** Detalhe expandido do plano de recuperação de faturamento. */
export function recuperacaoDetalheHtml(r) {
  const linha = (l, v) => `<div class="dex-conf-item"><span>${l}</span><b>${v}</b></div>`;
  const cenarios = r.cenarios ? `
    <div class="dex-sim-grid">
      <div class="dex-sim-item"><span>Cenário conservador</span><b>${fmtMoeda(r.cenarios.conservador)}/dia</b></div>
      <div class="dex-sim-item"><span>Recuperação parcial</span><b>${fmtMoeda(r.cenarios.parcial)}/dia</b></div>
      <div class="dex-sim-item"><span>Recuperação forte</span><b>${fmtMoeda(r.cenarios.forte)}/dia</b></div>
    </div>` : "";
  return `
    <div class="dex-conf-grid">
      ${linha("Faturamento de referência (mês anterior)", fmtMoeda(r.referencia))}
      ${linha("Faturamento registrado até agora", fmtMoeda(r.atual))}
      ${linha("Faltante para a referência", fmtMoeda(r.faltante))}
      ${linha("Dias operacionais restantes", r.diasRestantes)}
      ${linha("Média diária atual", r.mediaAtual == null ? "—" : fmtMoeda(r.mediaAtual))}
      ${linha("Média diária necessária", r.mediaNecessaria == null ? "—" : fmtMoeda(r.mediaNecessaria))}
    </div>
    ${cenarios}
    <p class="dex-sim-fonte">Cenários matemáticos a partir do ritmo atual — não são uma previsão estatística.</p>`;
}

/**
 * Um card do Plano. `numero` = posição na sequência (só CRITICAL/WARNING);
 * null -> ícone no lugar do número (HEALTHY/DATA_PENDING).
 * `deps.botaoDiagnosticoHtml(attentionPoint, tipo)` é injetado por
 * dashboardExecutivo.js (versão com o gate do módulo Inteligência).
 */
function cardHtml(item, numero, deps) {
  const classe = CLASSE_TIPO[item.tipo] ?? "";
  const badge = BADGE_TIPO[item.tipo];
  const cta = ctaHtml(item.cta);
  const ap = attentionPointDe(item);
  const diagnosticar = ap && deps.botaoDiagnosticoHtml ? deps.botaoDiagnosticoHtml(ap, item.tipo) : "";
  const marcador = numero != null
    ? `<div class="dex-acao-num">${numero}</div>`
    : `<div class="dex-acao-ic">${icon(item.tipo === "HEALTHY" ? "check-circle" : "clipboard-list", { size: 15 })}</div>`;

  let corpo;
  if (item.tipo === "HEALTHY") {
    corpo = `
      ${numerosHtml(item)}
      ${item.status ? `<p class="dex-acao-status">${escapeHtml(item.status)}</p>` : ""}
      <button class="btn btn-ghost btn-sm dex-acao-manter" data-cta-expandir type="button">Como manter este resultado</button>
      ${diagnosticar}
      <div class="dex-acao-detalhe" hidden>
        <p class="dex-acao-sit">${escapeHtml(item.explicacao)}</p>
        ${item.comoPreservar ? `<p class="dex-acao-rec"><b>Para preservar:</b> ${escapeHtml(item.comoPreservar)}</p>` : ""}
        ${item.objetivo?.ideal ? `<p class="dex-acao-obj"><b>Objetivo:</b> ${escapeHtml(item.objetivo.ideal)}</p>` : ""}
        ${cta}
      </div>`;
  } else if (item.tipo === "DATA_PENDING") {
    corpo = `
      <p class="dex-acao-sit">${escapeHtml(item.explicacao)}</p>
      ${item.acaoRecomendada ? `<p class="dex-acao-rec">${escapeHtml(item.acaoRecomendada)}</p>` : ""}
      ${cta}
      ${diagnosticar}`;
  } else {
    corpo = `
      ${numerosHtml(item)}
      <p class="dex-acao-sit">${escapeHtml(item.explicacao)}</p>
      ${item.impacto ? `<p class="dex-acao-impacto"><b>Impacto:</b> ${escapeHtml(item.impacto)}</p>` : ""}
      ${item.acaoRecomendada ? `<p class="dex-acao-rec"><b>O que fazer agora:</b> ${escapeHtml(item.acaoRecomendada)}</p>` : ""}
      ${objetivoHtml(item.objetivo)}
      ${cta}
      ${diagnosticar}
      ${item.detalhe ? `<div class="dex-acao-detalhe" hidden>${recuperacaoDetalheHtml(item.detalhe)}</div>` : ""}`;
  }

  return `<div class="dex-acao ${classe} dex-acao-${item.tipo.toLowerCase().replace(/_/g, "-")}">
    ${marcador}
    <div class="dex-acao-corpo">
      <b class="dex-acao-titulo">${dot(DOT_TIPO[item.tipo] ?? "muted")} ${escapeHtml(item.titulo)}${badge ? ` <span class="pill ${badge.classe} dex-acao-badge">${badge.texto}</span>` : ""}</b>
      ${corpo}
    </div>
  </div>`;
}

function contadorChip(n, singular, plural, classe) {
  if (!n) return "";
  return `<span class="pill ${classe} dex-plano-chip">${n} ${n === 1 ? singular : plural}</span>`;
}

/**
 * Resumo determinístico do momento da operação (backend: diagnostico.resumo).
 * A linha de confiabilidade reaproveita `diagnostico.confiabilidade` — nunca
 * duplica a regra, só reapresenta.
 */
function resumoHtml(resumo, confiabilidade) {
  if (!resumo) return "";
  const c = resumo.contadores ?? {};
  const chips = [
    contadorChip(c.criticos, "crítico", "críticos", "bad"),
    contadorChip(c.atencoes, "atenção", "atenções", "warn"),
    contadorChip(c.saudaveis, "saudável", "saudáveis", "ok"),
    contadorChip(c.dadosPendentes, "pendência de dados", "pendências de dados", "muted"),
  ].join("");
  const conf = confiabilidade && confiabilidade.nivel !== "alta" && confiabilidade.nivel !== "indisponivel"
    ? `<p class="dex-plano-conf">Análise baseada nos dados disponíveis — ${escapeHtml(confiabilidade.motivo)}.</p>`
    : "";
  return `<div class="dex-plano-resumo dex-plano-resumo-${ESTADO_CLASSE[resumo.estado] ?? "dados"}">
    <b class="dex-plano-manchete">${escapeHtml(resumo.manchete)}</b>
    ${chips ? `<div class="dex-plano-chips">${chips}</div>` : ""}
    <p class="dex-plano-texto">${escapeHtml(resumo.texto)}</p>
    ${conf}
  </div>`;
}

function blocoHtml(iconeNome, titulo, cards) {
  if (!cards) return "";
  return `<div class="dex-plano-bloco">
    <h4 class="dex-plano-bloco-titulo">${icon(iconeNome, { size: 13 })} ${titulo}</h4>
    ${cards}
  </div>`;
}

/**
 * @param {object} diag objeto `diagnostico` do backend
 * @param {{botaoDiagnosticoHtml?: (attentionPoint: string, tipo: string) => string}} [deps]
 * @returns {string} HTML interno da seção "Plano de Ação"
 */
export function planoAcaoHtml(diag, deps = {}) {
  const resumo = resumoHtml(diag.resumo, diag.confiabilidade);

  if (diag.semDadosSuficientes) {
    return `${resumo}<p class="dex-diag-vazio">Ainda não há lançamentos suficientes neste mês para gerar um plano de ação.</p>`;
  }

  const acoes = diag.acoes ?? [];
  const manutencao = diag.manutencao ?? [];
  const criticas = acoes.filter((a) => a.tipo === "CRITICAL");
  const atencoes = acoes.filter((a) => a.tipo === "WARNING");
  const pendencias = acoes.filter((a) => a.tipo === "DATA_PENDING");

  // Numeração contínua só nas ações do plano (CRITICAL -> WARNING); HEALTHY e
  // DATA_PENDING recebem ícone no lugar do número.
  let n = 0;
  const numeradas = (arr) => arr.map((it) => cardHtml(it, ++n, deps)).join("");
  const soltas = (arr) => arr.map((it) => cardHtml(it, null, deps)).join("");

  const blocos = [
    blocoHtml("alert-triangle", "Prioridades agora", numeradas(criticas)),
    blocoHtml("trending-up", "Acompanhar de perto", numeradas(atencoes)),
    blocoHtml("check-circle", "Manter o que está funcionando", soltas(manutencao)),
    blocoHtml("clipboard-list", "Qualidade dos dados", soltas(pendencias)),
  ].join("");

  return `${resumo}${blocos}`;
}
