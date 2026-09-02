// As telas do PAINEL ADMINISTRATIVO da Crescer.
//
// FASE D: o ambiente existe, é navegável e protegido — mas o MOTOR de
// monitoramento (statusMes cross-tenant, D-1, conformidade, pendências) só
// entra nas fases E/F. Aqui só "Visão Geral" abre uma tela real; as demais
// nascem no menu como "Em breve" (nunca dados inventados).
//
// Mesmo espírito de adminViews.js: funções que devolvem/injetam HTML, sem
// estado. `#padm-view` é o container.
import { el, escapeHtml } from "./utils.js";
import { icon } from "./icons.js";

/** Menu do painel — já nasce com as 5 áreas planejadas. `pronto` marca o que existe hoje. */
export const TELAS_PADM = [
  { id: "visao-geral",   label: "Visão Geral",          icone: "target",         pronto: true },
  { id: "diario",        label: "Monitoramento Diário", icone: "calendar",       pronto: false },
  { id: "pendencias",    label: "Pendências",           icone: "alert-triangle", pronto: false },
  { id: "empresas",      label: "Empresas",             icone: "building",       pronto: false },
  { id: "historico",     label: "Histórico",            icone: "archive",        pronto: false },
];

const view = () => el("#padm-view");

const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;

/**
 * Renderiza a view atual. Só "visao-geral" tem conteúdo real (placeholder);
 * qualquer outra cai no aviso "Em breve" — nunca inventa indicador.
 * @param {string} telaId
 */
export function renderViewPadm(telaId) {
  const tela = TELAS_PADM.find((t) => t.id === telaId) ?? TELAS_PADM[0];
  view().innerHTML = carregando();
  view().innerHTML = tela.pronto ? viewVisaoGeral() : viewEmBreve(tela);
}

// ---------------------------------------------------------------------------
// Visão Geral — PLACEHOLDER real (item 11). Sem números inventados.
// ---------------------------------------------------------------------------
function viewVisaoGeral() {
  return `
    <section class="padm-hero">
      <h2 class="padm-hero-tit">Painel Administrativo</h2>
      <p class="padm-hero-sub">Monitoramento das operações</p>
      <p class="padm-hero-msg">O monitoramento consolidado das empresas será exibido aqui.</p>
      <p class="padm-hero-nota">O <b>Dashboard iFood</b> (fechamento diário D-1) será o primeiro monitor.</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Em breve — para as áreas ainda sem motor (item 10).
// ---------------------------------------------------------------------------
function viewEmBreve(tela) {
  return `
    <section class="padm-vazio">
      <span class="padm-vazio-ic">${icon(tela.icone, { size: 26 })}</span>
      <h3>${escapeHtml(tela.label)}</h3>
      <p>Em breve. Esta área entra junto com o motor de monitoramento do Dashboard iFood.</p>
    </section>`;
}
