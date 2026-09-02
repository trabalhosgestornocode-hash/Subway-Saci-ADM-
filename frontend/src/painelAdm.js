// Shell do PAINEL ADMINISTRATIVO da Crescer — menu, pilha de navegação interna
// e a ação "Trocar ambiente".
//
// Vive no mesmo SPA que o app do tenant e que o Painel SuperAdmin, mas num
// shell IRMÃO (#painel-adm-screen), nunca visível ao mesmo tempo. Nenhuma view
// daqui lê `state.sessao.empresa` nem depende do Context Token — é o que
// garante, no código, que o Painel Administrativo não opera sob o contexto de
// um cliente (mesma disciplina de admin.js).
//
// FASE G: telas reais (Visão Geral, Monitoramento Diário, Pendências,
// Empresas, Histórico) consumindo /api/v1/administrativo/*. O detalhe de
// empresa e o calendário de unidade são navegação INTERNA (pilha), não troca
// de contexto tenant.

import { state } from "./state.js";
import { el, els, toast } from "./utils.js";
import { icon } from "./icons.js";
import { painelAdmApi } from "./painelAdmApi.js";
import { TELAS_PADM, renderViewPadm, ligarNavegacao, resetFiltrosDiario } from "./painelAdmViews.js";

/** @type {{mostrarTela: Function, aoTrocarAmbiente: Function, aoAcessoRevogado: Function, usuario: object}|null} */
let ganchos = null;
let eventosLigados = false;
let apiAtual = painelAdmApi;

/**
 * Pilha de navegação interna do painel. O topo é o que está na tela.
 * `[{tipo:"tela", id}]` para as abas; empurra `{tipo:"empresa"...}` /
 * `{tipo:"calendario"...}` ao abrir detalhes. NÃO é histórico de rotas do
 * browser — é só a navegação para trás dentro do painel.
 * @type {Array<object>}
 */
let pilha = [];
const topo = () => pilha[pilha.length - 1] ?? { tipo: "tela", id: TELAS_PADM[0].id };

/**
 * Abre o Painel Administrativo. Injeta as dependências do app.js.
 *
 * VALIDAÇÃO REAL: antes de trocar de shell, chama `GET /administrativo/ping`.
 * Se 403 (acesso revogado), NÃO abre — devolve o controle ao app.js via
 * `aoAcessoRevogado`.
 *
 * @param {{mostrarTela: (t: string) => void, aoTrocarAmbiente: () => void, aoAcessoRevogado: (msg: string) => void, usuario: object, api?: typeof painelAdmApi}} opcoes
 * @returns {Promise<boolean>} true se abriu.
 */
export async function abrirPainelAdministrativo(opcoes) {
  ganchos = opcoes;
  apiAtual = opcoes.api ?? painelAdmApi;

  try {
    await apiAtual.ping();
  } catch (e) {
    if (e.status === 403) {
      opcoes.aoAcessoRevogado?.(
        e.message || "Seu acesso ao Painel Administrativo não está mais disponível.",
      );
      return false;
    }
    toast("Não foi possível abrir o Painel Administrativo: " + e.message);
    return false;
  }

  ligarNavegacao({
    abrirEmpresa: abrirDetalheEmpresa,
    abrirUnidade: abrirCalendarioUnidade,
    voltar: voltarPadm,
    irParaTela: irParaPadm,
    aoAcessoRevogado: (msg) => {
      state.telaPainelAdm = null;
      opcoes.aoAcessoRevogado?.(msg);
    },
  });

  montarMenu();
  preencherUsuario(opcoes.usuario ?? state.sessao.usuario);
  opcoes.mostrarTela("painelAdm");
  ligarEventos();
  await irParaPadm(state.telaPainelAdm || TELAS_PADM[0].id);
  return true;
}

/** Sai do Painel Administrativo e volta para a seleção de ambientes. */
export function sairDoPainelAdministrativo() {
  el("#painel-adm-screen")?.classList.remove("menu-aberto");
  state.telaPainelAdm = null;
  pilha = [];
  ganchos?.aoTrocarAmbiente?.();
}

// ---------------------------------------------------------------------------
// Menu e navegação
// ---------------------------------------------------------------------------
function montarMenu() {
  const menu = el("#padm-menu");
  if (!menu) return;
  menu.innerHTML = `<li class="menu-secao">Monitoramento</li>` + TELAS_PADM.map((t) => `
    <li data-tela="${t.id}">
      <span class="m-icon">${icon(t.icone, { size: 15 })}</span>
      <span class="m-label">${t.label}</span>
    </li>`).join("");
  els("#padm-menu li[data-tela]").forEach((li) =>
    li.addEventListener("click", () => irParaPadm(li.dataset.tela)));
}

/** Aba de topo — zera a pilha e os filtros do Monitoramento Diário. */
export function irParaPadm(telaId) {
  const tela = TELAS_PADM.find((t) => t.id === telaId) ?? TELAS_PADM[0];
  state.telaPainelAdm = tela.id;
  resetFiltrosDiario();
  pilha = [{ tipo: "tela", id: tela.id }];
  els("#padm-menu li[data-tela]").forEach((li) =>
    li.classList.toggle("ativo", li.dataset.tela === tela.id));
  el("#painel-adm-screen")?.classList.remove("menu-aberto");
  return renderPadmAtual();
}

/** Empurra o detalhe de uma empresa. */
export function abrirDetalheEmpresa(empresaId, empresaNome) {
  if (!empresaId) return;
  pilha.push({ tipo: "empresa", empresaId, empresaNome });
  return renderPadmAtual();
}

/**
 * Empurra (ou, na troca de mês, substitui) o calendário de uma unidade.
 * @param {string} unidadeId @param {string} [unidadeNome] @param {string} [mes] AAAA-MM
 */
export function abrirCalendarioUnidade(unidadeId, unidadeNome, mes) {
  if (!unidadeId) return;
  const t = topo();
  const entrada = { tipo: "calendario", unidadeId, unidadeNome, mes: mes || null };
  if (t.tipo === "calendario" && t.unidadeId === unidadeId) pilha[pilha.length - 1] = entrada;
  else pilha.push(entrada);
  return renderPadmAtual();
}

/** Volta um nível na pilha (calendário → empresa → aba). */
export function voltarPadm() {
  if (pilha.length > 1) pilha.pop();
  return renderPadmAtual();
}

function tituloDoTopo() {
  const t = topo();
  if (t.tipo === "empresa") return t.empresaNome || "Empresa";
  if (t.tipo === "calendario") return t.unidadeNome || "Calendário";
  return TELAS_PADM.find((x) => x.id === t.id)?.label ?? "Painel Administrativo";
}

function renderPadmAtual() {
  const titulo = el("#padm-titulo");
  if (titulo) titulo.textContent = tituloDoTopo();
  return renderViewPadm(topo(), { api: apiAtual });
}

function preencherUsuario(usuario) {
  const nome = usuario?.nome || usuario?.email || "—";
  const setar = (sel, txt) => { const n = el(sel); if (n) n.textContent = txt; };
  setar("#padm-nome", nome);
  setar("#padm-email", usuario?.email ?? "—");
  const avatar = el("#padm-avatar");
  if (avatar) avatar.textContent = (nome[0] || "C").toUpperCase();
}

function ligarEventos() {
  if (eventosLigados) return;
  eventosLigados = true;
  el("#padm-trocar")?.addEventListener("click", sairDoPainelAdministrativo);
  el("#padm-btn-menu")?.addEventListener("click", () => el("#painel-adm-screen")?.classList.toggle("menu-aberto"));
  el("#padm-backdrop")?.addEventListener("click", () => el("#painel-adm-screen")?.classList.remove("menu-aberto"));
  // "Tentar de novo" dos estados de erro.
  el("#padm-view")?.addEventListener("click", (e) => {
    if (e.target.closest('[data-padm-acao="recarregar"]')) renderPadmAtual();
  });
}
