// Modal "Editar meta" — Metas e Bonificações (item 76-B). Direção, vigência
// e faixas 100% editáveis pela UI, nada hardcoded. Editar SEMPRE cria uma
// nova vigência a partir da data escolhida (o backend fecha a anterior sem
// apagar — bonificacaoMensal.service.js#salvarMeta); esta tela só monta o
// payload, a regra de vigência vive inteira no backend.
import { escapeHtml, toast } from "./utils.js";
import { bonifSalvarMeta } from "./api.js";

let ov = null;
function fecharOverlay() { ov?.remove(); ov = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function overlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal bm-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

const INFO = {
  faturamento: { label: "Faturamento", icon: "💰" }, bebidas: { label: "Bebidas", icon: "🥤" },
  adicionais: { label: "Adicionais", icon: "🧀" }, diversos: { label: "Diversos", icon: "🍪" },
  cmv: { label: "CMV", icon: "📉" }, ticket_medio: { label: "Ticket Médio", icon: "🎟️" },
  avaliacao_ifood: { label: "Avaliação/Nota iFood", icon: "⭐" }, cancelamentos: { label: "Cancelamentos", icon: "🚫" },
  pedidos_chamado: { label: "Pedidos com Chamado", icon: "☎️" }, rev: { label: "REV", icon: "📶" },
  pesquisas: { label: "Pesquisas", icon: "📝" },
};
const TIPOS_FAIXA = [
  { valor: "limite_minimo", label: "A partir de um valor mínimo" },
  { valor: "limite_maximo", label: "Até um valor máximo" },
  { valor: "intervalo", label: "Dentro de um intervalo" },
];

let ctx = null; // { indicador, linhaSeq } — estado do modal aberto

export function abrirEditarMetaModal({ indicador, metaAtual, onSalvo }) {
  const info = INFO[indicador] ?? { label: indicador, icon: "🎯" };
  const hojeIso = new Date().toISOString().slice(0, 10);
  const faixasIniciais = metaAtual?.faixas?.length
    ? metaAtual.faixas.slice().sort((a, b) => a.ordem - b.ordem)
    : [{ ordem: 1, tipo: "limite_minimo", valorMin: null, valorMax: null, bonus: null }];
  ctx = { indicador, linhaSeq: faixasIniciais.length };

  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>🎯 Editar meta — ${info.icon} ${escapeHtml(info.label)}</h2></div>
    <form id="bm-meta-form" class="bm-imp-form">
      <div class="cfg-form-grid">
        <label class="cfg-campo"><span>Direção</span>
          <select id="bm-meta-direcao">
            <option value="higher_is_better" ${metaAtual?.direcao !== "lower_is_better" ? "selected" : ""}>Quanto maior, melhor</option>
            <option value="lower_is_better" ${metaAtual?.direcao === "lower_is_better" ? "selected" : ""}>Quanto menor, melhor</option>
          </select></label>
        <label class="cfg-campo"><span>Vigente a partir de</span>
          <input type="date" id="bm-meta-validfrom" value="${hojeIso}" min="${hojeIso}"></label>
      </div>
      <p class="dex-diag-vazio">Salvar cria uma vigência nova a partir dessa data — meses já vividos continuam avaliados pela regra anterior. Escolha hoje pra valer imediatamente, ou uma data futura pra agendar a mudança.</p>
      <div id="bm-meta-faixas">${faixasIniciais.map((f, i) => faixaLinhaHtml(f, i)).join("")}</div>
      <button type="button" class="btn btn-ghost btn-sm" id="bm-meta-add-faixa">+ Nova faixa</button>
      <div class="ed-acoes">
        <button type="button" class="btn btn-ghost" id="bm-meta-cancelar">Cancelar</button>
        <button type="submit" class="btn btn-primary" id="bm-meta-salvar">Salvar</button>
      </div>
    </form>`);

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#bm-meta-cancelar").addEventListener("click", fecharOverlay);
  m.querySelector("#bm-meta-add-faixa").addEventListener("click", () => adicionarFaixa(m));
  wireRemoverFaixas(m);
  m.querySelector("#bm-meta-form").addEventListener("submit", (e) => salvar(e, m, { indicador, onSalvo }));
}

function faixaLinhaHtml(f, i) {
  return `<div class="cfg-form-grid bm-meta-faixa-linha" data-faixa data-seq="${i}">
    <label class="cfg-campo"><span>Faixa ${i + 1} — tipo</span>
      <select class="bm-meta-tipo">${TIPOS_FAIXA.map((t) => `<option value="${t.valor}" ${f.tipo === t.valor ? "selected" : ""}>${t.label}</option>`).join("")}</select></label>
    <label class="cfg-campo"><span>Valor mínimo</span><input type="number" step="any" class="bm-meta-min" value="${f.valorMin ?? ""}" placeholder="—"></label>
    <label class="cfg-campo"><span>Valor máximo</span><input type="number" step="any" class="bm-meta-max" value="${f.valorMax ?? ""}" placeholder="—"></label>
    <label class="cfg-campo"><span>Bonificação (R$)</span><input type="number" step="0.01" class="bm-meta-bonus" value="${f.bonus ?? ""}" placeholder="sem valor definido"></label>
    <button type="button" class="btn btn-ghost btn-sm bm-meta-remover" title="Remover faixa">🗑️</button>
  </div>`;
}

function adicionarFaixa(m) {
  const box = m.querySelector("#bm-meta-faixas");
  const i = ctx.linhaSeq++;
  box.insertAdjacentHTML("beforeend", faixaLinhaHtml({ ordem: i + 1, tipo: "limite_minimo", valorMin: null, valorMax: null, bonus: null }, i));
  wireRemoverFaixas(m);
}

function wireRemoverFaixas(m) {
  m.querySelectorAll(".bm-meta-remover").forEach((btn) => {
    btn.onclick = () => {
      const linhas = m.querySelectorAll("[data-faixa]");
      if (linhas.length <= 1) return toast("Precisa de ao menos uma faixa.");
      btn.closest("[data-faixa]").remove();
    };
  });
}

async function salvar(e, m, { indicador, onSalvo }) {
  e.preventDefault();
  const direcao = m.querySelector("#bm-meta-direcao").value;
  const validFrom = m.querySelector("#bm-meta-validfrom").value;
  if (!validFrom) return toast("Informe a partir de quando a meta vale.");
  const linhas = [...m.querySelectorAll("[data-faixa]")];
  const faixas = linhas.map((linha, i) => ({
    ordem: i + 1,
    tipo: linha.querySelector(".bm-meta-tipo").value,
    valorMin: linha.querySelector(".bm-meta-min").value === "" ? null : linha.querySelector(".bm-meta-min").value,
    valorMax: linha.querySelector(".bm-meta-max").value === "" ? null : linha.querySelector(".bm-meta-max").value,
    bonus: linha.querySelector(".bm-meta-bonus").value === "" ? null : linha.querySelector(".bm-meta-bonus").value,
  }));

  const btn = m.querySelector("#bm-meta-salvar");
  btn.disabled = true; const txt = btn.textContent; btn.textContent = "Salvando…";
  try {
    await bonifSalvarMeta(indicador, { direcao, validFrom, faixas });
    toast("Meta salva ✅");
    fecharOverlay();
    await onSalvo?.();
  } catch (err) {
    toast("Erro: " + err.message);
    btn.disabled = false; btn.textContent = txt;
  }
}
