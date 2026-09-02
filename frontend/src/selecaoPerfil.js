// Tela "Selecione seu usuário" (Fase F) — SÓ aparece quando a CONTA
// (e-mail+senha) tem 2+ perfis operacionais ativos.
//
// Responsabilidades: renderizar os cards de perfil e o painel de PIN, e chamar
// os callbacks. NUNCA guarda PIN, hash, prova ou id técnico fora do necessário.
// A orquestração (chamar backend, decidir para onde ir) fica em app.js.

import { el, escapeHtml } from "./utils.js";

/**
 * Monta a lista de perfis.
 * @param {{ perfis: Array<{id,nome,empresas?}>, contaLabel: string,
 *           configIncompleta?: boolean, onEscolher: (perfil) => void }} p
 */
export function montarSelecaoPerfil({ perfis, contaLabel, configIncompleta = false, onEscolher }) {
  el("#selp-conta").textContent = contaLabel || "—";
  fecharPinDoPerfil();

  const aviso = el("#selp-aviso");
  if (configIncompleta) {
    aviso.textContent = "Esta conta precisa ter os PINs dos usuários configurados pelo administrador.";
    aviso.hidden = false;
  } else {
    aviso.hidden = true;
  }

  const lista = el("#selp-lista");
  lista.innerHTML = perfis.map((p) => {
    const resumo = (p.empresas || []).map((e) => e.empresaNome).filter(Boolean).slice(0, 3).join(", ");
    return `
      <button class="sel-card" type="button" role="listitem" data-perfil="${escapeHtml(p.id)}"
              ${configIncompleta ? "disabled" : ""}>
        <span class="sel-card-nome">${escapeHtml(p.nome)}</span>
        ${resumo ? `<span class="sel-card-sub">${escapeHtml(resumo)}</span>` : ""}
      </button>`;
  }).join("");

  lista.querySelectorAll(".sel-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const perfil = perfis.find((x) => x.id === btn.dataset.perfil);
      if (perfil) onEscolher(perfil);
    });
  });

  // foco no primeiro card (acessibilidade / teclado)
  lista.querySelector(".sel-card:not([disabled])")?.focus();
}

/**
 * Abre o painel de PIN para um perfil.
 * @param {{ perfil: {id,nome}, onConfirmar: (pin: string) => void, onVoltar: () => void }} p
 */
export function abrirPinDoPerfil({ perfil, onConfirmar, onVoltar }) {
  el("#selp-lista").hidden = true;
  el("#selp-pin-nome").textContent = perfil.nome;
  setErroPin(null);
  setPinCarregando(false);

  const input = el("#selp-pin-input");
  input.value = "";
  el("#selp-pin").hidden = false;
  input.focus();

  const confirmar = () => {
    const pin = (el("#selp-pin-input")?.value || "").trim();
    if (!/^\d{4,6}$/.test(pin)) { setErroPin("Informe o PIN (4 a 6 dígitos)."); return; }
    onConfirmar(pin);
  };
  const voltar = () => { limparPin(); fecharPinDoPerfil(); onVoltar(); };

  // `.onclick` (não addEventListener) — sobrescreve o handler anterior, então
  // não empilha entre aberturas e não precisa recriar o <input> (o que apagaria
  // o que o usuário digitou).
  const btnOk = el("#selp-pin-ok"); if (btnOk) btnOk.onclick = confirmar;
  const btnVoltar = el("#selp-pin-voltar"); if (btnVoltar) btnVoltar.onclick = voltar;
  if (input) input.onkeydown = (e) => { if (e.key === "Enter") confirmar(); };

  return { confirmar, voltar };
}

export function setErroPin(msg) {
  const box = el("#selp-pin-erro");
  if (!msg) { box.hidden = true; box.textContent = ""; return; }
  box.textContent = msg;
  box.hidden = false;
}

export function setPinCarregando(carregando) {
  const btn = el("#selp-pin-ok");
  if (!btn) return;
  btn.disabled = !!carregando;
  btn.textContent = carregando ? "Validando…" : "Confirmar";
}

/** Zera o campo de PIN da memória visual (Fase F, ponto 11). */
export function limparPin() {
  const i = el("#selp-pin-input");
  if (i) i.value = "";
}

export function fecharPinDoPerfil() {
  limparPin();
  const pin = el("#selp-pin");
  if (pin) pin.hidden = true;
  const lista = el("#selp-lista");
  if (lista) lista.hidden = false;
}

/** Estado "conta sem nenhum usuário" (ponto 4). */
export function mostrarSemPerfil(contaLabel) {
  el("#selp-conta").textContent = contaLabel || "—";
  el("#selp-pin").hidden = true;
  el("#selp-aviso").hidden = true;
  el("#selp-lista").hidden = false;
  el("#selp-lista").innerHTML = `
    <div class="sel-vazio">
      <span class="sel-vazio-ic">🔒</span>
      <h3>Nenhum usuário disponível para esta conta</h3>
      <p>Peça ao administrador da plataforma para cadastrar um usuário nesta conta de acesso.</p>
    </div>`;
}

