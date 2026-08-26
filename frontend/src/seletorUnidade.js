// Seletor global de unidade no topbar (item 12): troca de unidade dentro da
// MESMA empresa sem sair do app — sem novo login, sem passar pela tela de
// seleção. Abrir/fechar o dropdown é o mesmo mecanismo de app.js#ligarMenuUsuario
// (o chip só precisa entrar na mesma lista de `fecharMenusUsuario`); este
// módulo só cuida do conteúdo: quais unidades aparecem e o que acontece ao
// escolher uma.
//
// Fonte dos dados: `state.sessao.acessos`, já carregado por sessao.js
// #listarAcessos antes de entrar no app — nenhuma chamada nova ao servidor
// só para desenhar o seletor.

import { el, escapeHtml, normalizarBusca, toast } from "./utils.js";
import { state } from "./state.js";

/**
 * (Re)monta o chip + dropdown a partir do contexto atual. Chamado por
 * app.js#mostrarApp a cada entrada no shell do tenant (login, troca de
 * unidade, restauração de sessão).
 * @param {{onTrocar: (opcao: object) => Promise<void>}} opts
 */
export function montarSeletorUnidade({ onTrocar }) {
  const { empresa, unidade, impersonando, acessos } = state.sessao;
  const chip = el("#chip-unidade");
  const texto = el("#chip-unidade-texto");
  const menu = el("#unidade-menu");
  texto.textContent = unidade?.nome || empresa?.nome || "—";
  menu.hidden = true;
  chip.setAttribute("aria-expanded", "false");

  const opcoesDaEmpresa = (acessos ?? []).filter(
    (o) => o.organizacaoId === empresa?.id && o.acessivel && o.unidadeId);

  // Nada pra trocar (uma unidade só nesta empresa, acesso no nível da
  // empresa inteira, ou impersonação — mesma regra que "Trocar unidade" já
  // usa no menu do usuário): o chip fica só informativo, do jeito que
  // sempre foi. Não vira botão à toa.
  const habilitado = !impersonando && opcoesDaEmpresa.length > 1;
  chip.classList.toggle("chip-unidade--clicavel", habilitado);
  chip.disabled = !habilitado;
  if (!habilitado) return;

  el("#um2-empresa").textContent = empresa?.nome ?? "—";
  const buscaWrap = el("#um2-busca-wrap");
  const busca = el("#um2-busca");
  buscaWrap.hidden = opcoesDaEmpresa.length <= 6;
  busca.value = "";

  function render() {
    const termo = normalizarBusca(busca.value.trim());
    const filtradas = termo
      ? opcoesDaEmpresa.filter((o) => normalizarBusca(o.unidadeNome ?? "").includes(termo))
      : opcoesDaEmpresa;

    const lista = el("#um2-lista");
    if (!filtradas.length) {
      lista.innerHTML = `<div class="unidade-menu-vazio">Nenhuma unidade encontrada.</div>`;
      return;
    }
    lista.innerHTML = filtradas.map((o) => {
      const atual = o.unidadeId === unidade?.id;
      return `
        <button type="button" class="unidade-menu-item ${atual ? "unidade-menu-item--atual" : ""}"
                data-uni="${escapeHtml(o.unidadeId)}" role="menuitemradio" aria-checked="${atual}">
          <span>${escapeHtml(o.unidadeNome ?? "—")}</span>
          ${atual ? '<span class="unidade-menu-check" aria-hidden="true">✓</span>' : ""}
        </button>`;
    }).join("");
  }

  el("#um2-lista").onclick = async (e) => {
    const btn = e.target.closest(".unidade-menu-item");
    if (!btn) return;
    menu.hidden = true;
    chip.setAttribute("aria-expanded", "false");
    if (btn.dataset.uni === unidade?.id) return; // já é a unidade atual
    const opcao = opcoesDaEmpresa.find((o) => o.unidadeId === btn.dataset.uni);
    if (!opcao) return;
    try {
      await onTrocar(opcao);
    } catch (err) {
      toast(err.message);
    }
  };

  busca.oninput = render;
  render();
}
