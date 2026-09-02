// Shell do PAINEL ADMINISTRATIVO da Crescer — menu, roteamento de views e a
// ação "Trocar ambiente".
//
// Vive no mesmo SPA que o app do tenant e que o Painel SuperAdmin, mas num
// shell IRMÃO (#painel-adm-screen), nunca visível ao mesmo tempo. Nenhuma view
// daqui lê `state.sessao.empresa` nem depende do Context Token — é o que
// garante, no código, que o Painel Administrativo não opera sob o contexto de
// um cliente (mesma disciplina de admin.js).
//
// É um ambiente GERENCIAL de MONITORAMENTO — não é o Painel SuperAdmin
// (técnico). São dois arquivos, dois shells, dois menus.
//
// FASE D: shell navegável + proteção real. O motor de monitoramento
// (Dashboard iFood cross-tenant) entra nas fases E/F.

import { state } from "./state.js";
import { el, els, toast } from "./utils.js";
import { icon } from "./icons.js";
import { painelAdmApi } from "./painelAdmApi.js";
import { TELAS_PADM, renderViewPadm } from "./painelAdmViews.js";

/** @type {{mostrarTela: Function, aoTrocarAmbiente: Function, aoAcessoRevogado: Function, usuario: object}|null} */
let ganchos = null;
let eventosLigados = false;

/**
 * Abre o Painel Administrativo. Injeta as dependências do app.js.
 *
 * VALIDAÇÃO REAL (item 8): antes de trocar de shell, chama
 * `GET /administrativo/ping`. Se 403 (acesso revogado enquanto a tela estava
 * aberta), NÃO abre — devolve o controle ao app.js via `aoAcessoRevogado`.
 *
 * @param {{mostrarTela: (t: string) => void, aoTrocarAmbiente: () => void, aoAcessoRevogado: (msg: string) => void, usuario: object, api?: typeof painelAdmApi}} opcoes
 * @returns {Promise<boolean>} true se abriu.
 */
export async function abrirPainelAdministrativo(opcoes) {
  ganchos = opcoes;
  const api = opcoes.api ?? painelAdmApi;

  try {
    await api.ping();
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

  montarMenu();
  preencherUsuario(opcoes.usuario ?? state.sessao.usuario);
  opcoes.mostrarTela("painelAdm");
  ligarEventos();
  irParaPadm(state.telaPainelAdm || TELAS_PADM[0].id);
  return true;
}

/** Sai do Painel Administrativo e volta para a seleção de ambientes (item 13). */
export function sairDoPainelAdministrativo() {
  el("#painel-adm-screen")?.classList.remove("menu-aberto");
  state.telaPainelAdm = null;
  ganchos?.aoTrocarAmbiente?.();
}

// ---------------------------------------------------------------------------
// Menu e navegação
// ---------------------------------------------------------------------------
function montarMenu() {
  const menu = el("#padm-menu");
  if (!menu) return;
  menu.innerHTML = `<li class="menu-secao">Monitoramento</li>` + TELAS_PADM.map((t) => `
    <li data-tela="${t.id}" class="${t.pronto ? "" : "padm-menu-embreve"}">
      <span class="m-icon">${icon(t.icone, { size: 15 })}</span>
      <span class="m-label">${t.label}</span>
      ${t.pronto ? "" : '<span class="pill muted padm-tag-embreve">Em breve</span>'}
    </li>`).join("");
  els("#padm-menu li[data-tela]").forEach((li) =>
    li.addEventListener("click", () => irParaPadm(li.dataset.tela)));
}

/** @param {string} telaId */
export function irParaPadm(telaId) {
  const tela = TELAS_PADM.find((t) => t.id === telaId) ?? TELAS_PADM[0];
  state.telaPainelAdm = tela.id;
  const titulo = el("#padm-titulo");
  if (titulo) titulo.textContent = tela.label;
  els("#padm-menu li[data-tela]").forEach((li) =>
    li.classList.toggle("ativo", li.dataset.tela === tela.id));
  el("#painel-adm-screen")?.classList.remove("menu-aberto");
  renderViewPadm(tela.id);
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
}
