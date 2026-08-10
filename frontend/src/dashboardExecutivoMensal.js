// Lançamento de Faturamento Mensal — para meses históricos onde o
// franqueado só sabe o total do mês, não o valor de cada dia. Distribui o
// total pelos dias sem lançamento (nunca sobrescreve dia já lançado).
//
// Fluxo simples de propósito (item 39 do pedido): NÃO é outro wizard de 4
// etapas — é mês/ano/valor -> prévia -> confirmar. O valor autoritativo é
// sempre o que o backend recalcula (distribuirValorMensal em
// dashboardExecutivo.calc.js), inclusive a exatidão em centavos.
import { el, escapeHtml, toast, fmtMoeda } from "./utils.js";
import { dashExecPreviewLancamentoMensal, dashExecConfirmarLancamentoMensal } from "./api.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

let ov = null;
let lm = null;

function fecharOverlay() { ov?.remove(); ov = null; lm = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function abrirOverlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal dex-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

// Campos extras — TODOS opcionais. Preenchidos, viram totais do mês que o
// backend distribui do mesmo jeito exato do faturamento (contagem inteira
// pra pedidos/clientes, centavo exato pra valores). Vazios, o dia gerado
// continua sem essa informação (null, nunca 0) — ver dashboardExecutivo.calc.js.
const CAMPOS_EXTRAS = [
  { campo: "qtdVendasTotal", label: "Quantidade de pedidos do mês", tipo: "int" },
  { campo: "novosClientesTotal", label: "Novos clientes do mês", tipo: "int" },
  { campo: "taxasComissoesTotal", label: "Taxas e comissões do mês (R$)", tipo: "money" },
  { campo: "servicosPromocoesTotal", label: "Serviços e promoções do mês (R$)", tipo: "money" },
  { campo: "taxasEntregadoresTotal", label: "Taxas de entregadores do mês (R$)", tipo: "money", ocultoSeFullService: true },
  { campo: "outrasDeducoesTotal", label: "Outras deduções do mês (R$)", tipo: "money" },
];

/**
 * @param {{unidadeId: string|null, mes: number, ano: number, modeloLogistico?: string, onSalvo: () => void}} p
 */
export function abrirLancamentoMensalModal({ unidadeId, mes, ano, modeloLogistico, onSalvo }) {
  // abrirOverlay() fecha qualquer modal anterior (fecharOverlay zera `lm`) —
  // por isso o estado só é atribuído DEPOIS de abrir o overlay novo, nunca
  // antes (mesma pegadinha documentada em dashboardExecutivoForm.js).
  const m = abrirOverlay("");
  lm = { unidadeId, mes, ano, modeloLogistico, valor: "", extras: {}, onSalvo };
  renderEntrada(m);
}

function renderEntrada(m) {
  const camposVisiveis = CAMPOS_EXTRAS.filter((c) => !(c.ocultoSeFullService && lm.modeloLogistico === "full_service"));
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>📅 Lançar faturamento mensal</h2></div>
    <p class="dex-form-info">Para meses históricos onde você só sabe o total faturado, não o valor de cada dia. O sistema distribui os valores proporcionalmente entre os dias do mês que ainda não têm lançamento.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Mês</span>
        <select id="lm-mes">${MESES.map((n, i) => `<option value="${i + 1}" ${i + 1 === lm.mes ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="cfg-campo"><span>Ano</span>
        <select id="lm-ano">${anosDisponiveis().map((a) => `<option value="${a}" ${a === lm.ano ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      <label class="cfg-campo ed-campo-full"><span>Faturamento total do mês (R$) *</span>
        <input type="number" min="0.01" step="0.01" id="lm-valor" value="${lm.valor}" placeholder="0,00"></label>
    </div>
    <p class="dex-form-info">📎 Dados complementares — preencha caso tenha esses totais do mês também. Nada aqui é obrigatório; o que ficar em branco fica "não informado", nunca zero.</p>
    <div class="cfg-form-grid">
      ${camposVisiveis.map((c) => `
        <label class="cfg-campo"><span>${c.label}</span>
          <input type="number" min="0" step="${c.tipo === "int" ? "1" : "0.01"}" data-extra="${c.campo}" value="${lm.extras[c.campo] ?? ""}" placeholder="Não informado"></label>`).join("")}
    </div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="lm-avancar">Ver prévia da distribuição</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-cancelar").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-mes").addEventListener("change", (e) => { lm.mes = Number(e.target.value); });
  m.querySelector("#lm-ano").addEventListener("change", (e) => { lm.ano = Number(e.target.value); });
  m.querySelector("#lm-valor").addEventListener("input", (e) => { lm.valor = e.target.value; });
  m.querySelectorAll("[data-extra]").forEach((input) => input.addEventListener("input", (e) => {
    lm.extras[e.target.dataset.extra] = e.target.value;
  }));
  m.querySelector("#lm-avancar").addEventListener("click", () => avancarParaPrevia(m));
}

/** Monta o corpo do pedido: extras vazios viram `undefined` (omitidos), nunca 0. */
function payloadExtras() {
  const p = {};
  for (const { campo } of CAMPOS_EXTRAS) {
    const v = lm.extras[campo];
    p[campo] = v === "" || v == null ? undefined : Number(v);
  }
  return p;
}

function anosDisponiveis() {
  const atual = new Date().getFullYear();
  const lista = [];
  for (let a = atual; a >= atual - 4; a--) lista.push(a);
  return lista;
}

async function avancarParaPrevia(m) {
  if (!lm.valor || Number(lm.valor) <= 0) { toast("Informe o faturamento total do mês."); return; }
  const btn = m.querySelector("#lm-avancar");
  btn.disabled = true; btn.textContent = "Calculando…";
  try {
    const { data } = await dashExecPreviewLancamentoMensal({
      unidadeId: lm.unidadeId || undefined, mes: lm.mes, ano: lm.ano, valorTotalMensal: Number(lm.valor),
      ...payloadExtras(),
    });
    renderPrevia(m, data);
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Ver prévia da distribuição";
  }
}

const ROTULO_EXTRA = Object.fromEntries(CAMPOS_EXTRAS.map((c) => [c.campo, c.label.replace(" do mês", "").replace(" (R$)", "")]));

function renderPrevia(m, preview) {
  const temLancamentosExistentes = preview.diasComLancamento > 0;
  const informados = preview.camposExtrasInformados ?? [];
  const naoInformados = CAMPOS_EXTRAS.map((c) => c.campo).filter((c) => !informados.includes(c));
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>📅 Confirmar distribuição — ${MESES[preview.mes - 1]}/${preview.ano}</h2></div>
    ${temLancamentosExistentes ? `
      <div class="dex-avisos">
        <b>⚠️ Este mês já possui ${preview.diasComLancamento} lançamento(s) individual(is).</b>
        <p>Esses dias NÃO serão alterados. A distribuição vai preencher só os ${preview.diasParaDistribuir} dia(s) que ainda estão sem lançamento.</p>
      </div>` : ""}
    <div class="dex-conf-grid">
      <div class="dex-conf-item"><span>Faturamento mensal informado</span><b>${fmtMoeda(preview.valorTotalMensal)}</b></div>
      <div class="dex-conf-item"><span>Dias que receberão distribuição</span><b>${preview.diasParaDistribuir}</b></div>
      <div class="dex-conf-item"><span>Valor médio aproximado por dia</span><b>${fmtMoeda(preview.valorMedioAproximado)}</b></div>
    </div>
    ${informados.length ? `<p class="dex-form-info">Também serão distribuídos: <b>${informados.map((c) => escapeHtml(ROTULO_EXTRA[c])).join(", ")}</b>.</p>` : ""}
    <div class="dex-form-info">
      Esses valores serão registrados como <b>distribuição estimada de faturamento mensal</b> — não como faturamento diário real. A grade de lançamentos vai marcar esses dias como "Estimado".${naoInformados.length ? ` ${naoInformados.map((c) => ROTULO_EXTRA[c]).join(", ")} continuam desconhecidos para esses dias (não inventamos o que não sabemos).` : ""}
    </div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-voltar">Voltar</button>
      <button class="btn btn-primary" id="lm-confirmar">Confirmar distribuição</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-voltar").addEventListener("click", () => renderEntrada(m));
  m.querySelector("#lm-confirmar").addEventListener("click", () => confirmar(m, preview));
}

async function confirmar(m, preview) {
  const btn = m.querySelector("#lm-confirmar");
  btn.disabled = true; btn.textContent = "Distribuindo…";
  // captura antes: fecharOverlay() zera `lm`
  const onSalvo = lm.onSalvo;
  const unidadeId = lm.unidadeId;
  const extras = payloadExtras();
  try {
    await dashExecConfirmarLancamentoMensal({ unidadeId: unidadeId || undefined, mes: preview.mes, ano: preview.ano, valorTotalMensal: preview.valorTotalMensal, ...extras });
    toast(`Faturamento de ${MESES[preview.mes - 1]}/${preview.ano} distribuído em ${preview.diasParaDistribuir} dia(s).`);
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Confirmar distribuição";
  }
}
