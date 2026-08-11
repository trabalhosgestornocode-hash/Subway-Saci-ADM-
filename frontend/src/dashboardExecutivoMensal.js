// Lançamento de Faturamento Mensal — para meses históricos onde o
// franqueado só sabe o total do mês, não o valor de cada dia. Distribui o
// total pelos dias sem lançamento (nunca sobrescreve dia já lançado).
//
// Fluxo simples de propósito (item 39 do pedido original): NÃO é outro
// wizard de 4 etapas — é mês/ano/valor -> prévia -> confirmar. O valor
// autoritativo é sempre o que o backend recalcula (distribuirValorMensal em
// dashboardExecutivo.calc.js), inclusive a exatidão em centavos.
//
// GERENCIAMENTO (visualizar/editar/excluir): quando o mês JÁ TEM um
// lançamento mensal, este modal nunca mais tenta criar um segundo — abre
// direto a tela de gerenciamento (ver dashboardExecutivo.service.js#lancamentoMensal,
// que agora bloqueia a criação duplicada com uma mensagem acionável). Editar
// só substitui o que o usuário de fato mexeu — campo intocado preserva o
// valor salvo, nunca vira zero nem some (ver atualizarLancamentoMensal).
import { el, escapeHtml, toast, fmtMoeda, fmtDataHora } from "./utils.js";
import { pode } from "./sessao.js";
import {
  dashExecPreviewLancamentoMensal, dashExecConfirmarLancamentoMensal,
  dashExecLancamentoMensal, dashExecAtualizarLancamentoMensal, dashExecExcluirLancamentoMensal,
} from "./api.js";

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

const podeEditarLote = () => pode("dashboard_executivo.corrigir");
const podeExcluirLote = () => pode("dashboard_executivo.excluir");

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
const ROTULO_EXTRA = Object.fromEntries(CAMPOS_EXTRAS.map((c) => [c.campo, c.label.replace(" do mês", "").replace(" (R$)", "")]));
const camposVisiveis = () => CAMPOS_EXTRAS.filter((c) => !(c.ocultoSeFullService && lm.modeloLogistico === "full_service"));

/**
 * @param {{unidadeId: string|null, mes: number, ano: number, modeloLogistico?: string, onSalvo: () => void, modoInicial?: 'ver'|'editar'|'excluir'}} p
 */
export async function abrirLancamentoMensalModal({ unidadeId, mes, ano, modeloLogistico, onSalvo, modoInicial }) {
  // abrirOverlay() fecha qualquer modal anterior (fecharOverlay zera `lm`) —
  // por isso o estado só é atribuído DEPOIS de abrir o overlay novo, nunca
  // antes (mesma pegadinha documentada em dashboardExecutivoForm.js).
  const m = abrirOverlay(`<div class="estado"><div class="spinner"></div>Carregando…</div>`);
  lm = { unidadeId, mes, ano, modeloLogistico, valor: "", extras: {}, onSalvo, lote: null, edicao: null };
  try {
    const { data } = await dashExecLancamentoMensal({ unidadeId: unidadeId || undefined, mes, ano });
    if (data.existe) {
      lm.lote = data;
      if (modoInicial === "editar") renderEdicao(m);
      else if (modoInicial === "excluir") renderConfirmarExclusao(m);
      else renderGerenciamento(m);
    } else {
      renderEntrada(m);
    }
  } catch (e) {
    m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
      <div class="estado erro"><span class="emoji">⚠️</span><h3>Erro ao carregar</h3><p>${escapeHtml(e.message)}</p></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  }
}

// ---------------------------------------------------------------------------
// CRIAÇÃO — só aparece quando o mês AINDA NÃO tem lançamento mensal (item 8:
// nunca mais bloqueia dizendo "já foi lançado" sem saída — quando já existe,
// abrirLancamentoMensalModal acima nem chega aqui, vai direto pro gerenciamento).
// ---------------------------------------------------------------------------
function renderEntrada(m) {
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
      ${camposVisiveis().map((c) => `
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

// ---------------------------------------------------------------------------
// GERENCIAMENTO — item 1/6/7 do pedido: ver o lançamento mensal ORIGINAL
// (não os dias distribuídos), com acesso a Editar e Excluir.
// ---------------------------------------------------------------------------
function linhaResumo(rotulo, valorHtml) {
  return `<div class="dex-conf-item"><span>${escapeHtml(rotulo)}</span><b>${valorHtml}</b></div>`;
}

function renderGerenciamento(m) {
  const lote = lm.lote;
  const linhasExtras = camposVisiveis().map((c) => {
    const valor = lote.extras[c.campo];
    const html = valor == null ? `<span class="dex-lm-nao-informado">Não informado</span>` : (c.tipo === "money" ? fmtMoeda(valor) : String(valor));
    return linhaResumo(c.label.replace(" do mês", ""), html);
  }).join("");
  const rodape = [
    `Criado em ${fmtDataHora(lote.criadoEm)}${lote.criadoPor?.nome ? ` por ${escapeHtml(lote.criadoPor.nome)}` : ""}.`,
    lote.atualizadoPor ? `Última atualização em ${fmtDataHora(lote.atualizadoEm)} por ${escapeHtml(lote.atualizadoPor.nome ?? lote.atualizadoPor.email ?? "—")}.` : "",
  ].filter(Boolean).join(" ");

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>📅 Lançamento mensal — ${MESES[lote.mes - 1]}/${lote.ano}</h2></div>
    <p class="dex-form-info">Origem: <b>distribuição mensal</b> (<code>monthly_distribution</code>) — este é o lançamento original que gerou os ${lote.diasDistribuidos} dia(s) estimados na grade, não os valores diários em si.</p>
    <div class="dex-conf-grid">
      ${linhaResumo("Faturamento mensal informado", fmtMoeda(lote.valorTotalMensal))}
      ${linhaResumo("Dias distribuídos", String(lote.diasDistribuidos))}
      ${linhaResumo("Valor médio por dia", fmtMoeda(lote.valorMedioAproximado))}
      ${linhasExtras}
    </div>
    ${lote.camposPendentes.length ? `<div class="dex-avisos"><b>📎 Dados complementares pendentes:</b> ${lote.camposPendentes.map((c) => escapeHtml(ROTULO_EXTRA[c])).join(", ")}. Use "Editar" para completar sem refazer o lançamento.</div>` : ""}
    <p class="dex-form-info">${rodape}</p>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-fechar">Fechar</button>
      ${podeEditarLote() ? `<button class="btn btn-ghost" id="lm-ir-editar">✏️ Editar / Atualizar lançamento</button>` : ""}
      ${podeExcluirLote() ? `<button class="btn btn-perigo" id="lm-ir-excluir">🗑️ Excluir lançamento mensal</button>` : ""}
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-fechar").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-ir-editar")?.addEventListener("click", () => renderEdicao(m));
  m.querySelector("#lm-ir-excluir")?.addEventListener("click", () => renderConfirmarExclusao(m));
}

// ---------------------------------------------------------------------------
// EDIÇÃO — item 2/3 do pedido: só substitui o que o usuário de fato editar.
// Campo deixado como estava (igual ao valor pré-preenchido) não é enviado —
// preserva o que já estava salvo, nunca vira zero nem some em silêncio.
// ---------------------------------------------------------------------------
function renderEdicao(m) {
  const lote = lm.lote;
  if (!lm.edicao) {
    lm.edicao = {
      valorTotalMensal: String(lote.valorTotalMensal),
      extras: Object.fromEntries(CAMPOS_EXTRAS.map((c) => [c.campo, lote.extras[c.campo] ?? ""])),
    };
  }
  const ed = lm.edicao;
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>✏️ Editar lançamento mensal — ${MESES[lote.mes - 1]}/${lote.ano}</h2></div>
    <p class="dex-form-info">Só o que você alterar aqui é substituído — o resto continua exatamente como estava salvo. Deixar um campo como está (sem mexer) não apaga o valor dele.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo ed-campo-full"><span>Faturamento total do mês (R$)</span>
        <input type="number" min="0.01" step="0.01" id="lm-ed-valor" value="${ed.valorTotalMensal}"></label>
    </div>
    <p class="dex-form-info">⚠️ Alterar o faturamento recalcula a distribuição pelos mesmos ${lote.diasDistribuidos} dia(s) já lançados — a soma continua batendo exatamente com o novo valor.</p>
    <div class="cfg-form-grid">
      ${camposVisiveis().map((c) => `
        <label class="cfg-campo"><span>${c.label}</span>
          <input type="number" min="0" step="${c.tipo === "int" ? "1" : "0.01"}" data-extra="${c.campo}" value="${ed.extras[c.campo]}" placeholder="Não informado"></label>`).join("")}
    </div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-ed-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="lm-ed-salvar">Salvar alterações</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-ed-cancelar").addEventListener("click", () => { lm.edicao = null; renderGerenciamento(m); });
  m.querySelector("#lm-ed-valor").addEventListener("input", (e) => { ed.valorTotalMensal = e.target.value; });
  m.querySelectorAll("[data-extra]").forEach((input) => input.addEventListener("input", (e) => {
    ed.extras[e.target.dataset.extra] = e.target.value;
  }));
  m.querySelector("#lm-ed-salvar").addEventListener("click", () => salvarEdicao(m));
}

/** Só entra no patch o que MUDOU em relação ao valor salvo (`lm.lote`) — chave ausente = "não editei", preserva o que já estava lá. */
function payloadPatchExtras() {
  const lote = lm.lote;
  const p = {};
  for (const { campo } of CAMPOS_EXTRAS) {
    const valorForm = lm.edicao.extras[campo];
    const valorOriginal = lote.extras[campo];
    const strOriginal = valorOriginal == null ? "" : String(valorOriginal);
    if (valorForm === strOriginal) continue; // intocado — não manda a chave
    p[campo] = valorForm === "" ? null : Number(valorForm); // limpou de propósito -> null explícito; senão, novo valor
  }
  return p;
}

async function salvarEdicao(m) {
  const valorForm = lm.edicao.valorTotalMensal;
  if (!valorForm || Number(valorForm) <= 0) { toast("Informe o faturamento total do mês."); return; }
  const patch = { valorTotalMensal: Number(valorForm), ...payloadPatchExtras() };
  const btn = m.querySelector("#lm-ed-salvar");
  btn.disabled = true; btn.textContent = "Salvando…";
  const loteId = lm.lote.id;
  const onSalvo = lm.onSalvo;
  try {
    const { data } = await dashExecAtualizarLancamentoMensal(loteId, patch);
    lm.lote = data; lm.edicao = null;
    toast(`Lançamento mensal de ${MESES[data.mes - 1]}/${data.ano} atualizado.`);
    renderGerenciamento(m);
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Salvar alterações";
  }
}

// ---------------------------------------------------------------------------
// EXCLUSÃO — item 4 do pedido: remove SÓ os dias gerados por este lote;
// lançamentos manuais no mesmo mês nunca são tocados (garantido no backend
// pelo vínculo distribuicao_mensal_id, não por comparação de valores).
// ---------------------------------------------------------------------------
function renderConfirmarExclusao(m) {
  const lote = lm.lote;
  const rotuloMes = `${MESES[lote.mes - 1]}/${lote.ano}`;
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>🗑️ Excluir lançamento mensal — ${rotuloMes}</h2></div>
    <div class="dex-avisos dex-avisos-perigo">
      <p><b>Você está prestes a excluir o lançamento mensal de ${rotuloMes} e os valores diários estimados gerados por ele.</b></p>
      <div class="dex-conf-grid">
        ${linhaResumo("Faturamento lançado", fmtMoeda(lote.valorTotalMensal))}
        ${linhaResumo("Dias afetados", String(lote.diasDistribuidos))}
      </div>
      <p>Lançamentos manuais (reais) no mesmo mês <b>não são afetados</b> — só os dias criados por esta distribuição. O registro completo fica guardado no log de exclusões.</p>
    </div>
    <label class="cfg-campo ed-campo-full"><span>Motivo da exclusão (obrigatório) *</span>
      <input type="text" id="lm-excl-motivo" placeholder="Explique por que este lançamento está sendo apagado"></label>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-excl-cancelar">Cancelar</button>
      <button class="btn btn-perigo" id="lm-excl-confirmar">Excluir lançamento</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-excl-cancelar").addEventListener("click", () => renderGerenciamento(m));
  m.querySelector("#lm-excl-confirmar").addEventListener("click", () => confirmarExclusaoLote(m));
}

async function confirmarExclusaoLote(m) {
  const motivo = m.querySelector("#lm-excl-motivo")?.value.trim() || "";
  if (motivo.length < 3) { toast("Informe o motivo da exclusão (mínimo 3 caracteres)."); return; }
  const btn = m.querySelector("#lm-excl-confirmar");
  const loteId = lm.lote.id;
  const unidadeId = lm.unidadeId; // captura antes: fecharOverlay() zera `lm`
  const onSalvo = lm.onSalvo;
  btn.disabled = true; btn.textContent = "Excluindo…";
  try {
    await dashExecExcluirLancamentoMensal(loteId, { unidadeId: unidadeId || undefined, motivo });
    toast("Lançamento mensal excluído.");
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Excluir lançamento";
  }
}
