// Seletor global de unidade no topbar (item 12): troca de unidade dentro da
// MESMA empresa sem sair do app — sem novo login, sem passar pela tela de
// seleção. Abrir/fechar o dropdown é o mesmo mecanismo de app.js#ligarMenuUsuario
// (o chip só precisa entrar na mesma lista de `fecharMenusUsuario`); este
// módulo só cuida do conteúdo: quais unidades aparecem e o que acontece ao
// escolher uma.
//
// Fonte dos dados: `state.sessao.unidadesDaEmpresa`, buscada por
// sessao.js#listarUnidadesContexto TODA vez que app.js#mostrarApp monta o
// shell do tenant (login, F5, troca de unidade e impersonação) — de
// propósito NÃO é `state.sessao.acessos` (aquilo é só o snapshot de login,
// nunca reconsultado depois; era exatamente por isso que o chip sumia num F5
// ou numa entrada via impersonação, mesmo com a empresa tendo várias
// unidades).
//
// Fase G (correção do "contexto sem saída"): o chip fica clicável sempre que
// existe mais de uma unidade para escolher — inclusive com `unidadeId` nulo
// ("Todas as unidades", que é um contexto tão válido quanto qualquer outro) e
// inclusive durante impersonação do SuperAdmin. NÃO existe mais nenhuma
// condição que esconda o seletor só por não haver unidade atual selecionada.

import { el, escapeHtml, normalizarBusca, toast } from "./utils.js";
import { state } from "./state.js";

/**
 * (Re)monta o chip + dropdown a partir do contexto atual. Chamado por
 * app.js#mostrarApp a cada entrada no shell do tenant (login, troca de
 * unidade, restauração de sessão, impersonação).
 * @param {{onTrocar: (opcao: object) => Promise<void>}} opts
 */
export function montarSeletorUnidade({ onTrocar }) {
  const { empresa, unidade, unidadesDaEmpresa } = state.sessao;
  const chip = el("#chip-unidade");
  const texto = el("#chip-unidade-texto");
  const menu = el("#unidade-menu");
  texto.textContent = unidade?.nome || (empresa ? "Todas as unidades" : "—");
  menu.hidden = true;
  chip.setAttribute("aria-expanded", "false");

  const unidades = unidadesDaEmpresa ?? [];

  // Nada pra trocar (uma unidade só nesta empresa, ou nenhuma unidade
  // individual visível para esta sessão): o chip fica só informativo, do
  // jeito que sempre foi. Não vira botão à toa. IMPORTANTE: isto NÃO depende
  // de `unidade` estar selecionada nem de impersonação — "Todas as unidades"
  // com 2+ unidades reais é justamente o caso que mais precisa do seletor.
  const habilitado = unidades.length > 1;
  chip.classList.toggle("chip-unidade--clicavel", habilitado);
  chip.disabled = !habilitado;
  if (!habilitado) return;

  el("#um2-empresa").textContent = empresa?.nome ?? "—";
  const buscaWrap = el("#um2-busca-wrap");
  const busca = el("#um2-busca");
  buscaWrap.hidden = unidades.length <= 6;
  busca.value = "";

  function itemHtml(uni, nome) {
    const atual = uni === (unidade?.id ?? null);
    return `
      <button type="button" class="unidade-menu-item ${atual ? "unidade-menu-item--atual" : ""}"
              data-uni="${uni === null ? "" : escapeHtml(uni)}" role="menuitemradio" aria-checked="${atual}">
        <span>${escapeHtml(nome)}</span>
        ${atual ? '<span class="unidade-menu-check" aria-hidden="true">✓</span>' : ""}
      </button>`;
  }

  function render() {
    const termo = normalizarBusca(busca.value.trim());
    const filtradas = termo
      ? unidades.filter((u) => normalizarBusca(u.nome ?? "").includes(termo))
      : unidades;

    const lista = el("#um2-lista");
    // "Todas as unidades" fica sempre visível no topo, mesmo com busca ativa
    // — é a opção consolidada da empresa inteira, não uma unidade pra filtrar.
    const cabecalho = termo ? "" : itemHtml(null, "Todas as unidades");
    if (!filtradas.length) {
      lista.innerHTML = cabecalho || `<div class="unidade-menu-vazio">Nenhuma unidade encontrada.</div>`;
      return;
    }
    lista.innerHTML = cabecalho + filtradas.map((u) => itemHtml(u.id, u.nome ?? "—")).join("");
  }

  el("#um2-lista").onclick = async (e) => {
    const btn = e.target.closest(".unidade-menu-item");
    if (!btn) return;
    menu.hidden = true;
    chip.setAttribute("aria-expanded", "false");
    const uniId = btn.dataset.uni || null;
    if (uniId === (unidade?.id ?? null)) return; // já é a opção atual
    const opcao = uniId === null
      ? { organizacaoId: empresa.id, unidadeId: null, unidadeNome: null }
      : { organizacaoId: empresa.id, unidadeId: uniId, unidadeNome: unidades.find((u) => u.id === uniId)?.nome ?? null };
    try {
      await onTrocar(opcao);
    } catch (err) {
      toast(err.message);
    }
  };

  busca.oninput = render;
  render();
}
