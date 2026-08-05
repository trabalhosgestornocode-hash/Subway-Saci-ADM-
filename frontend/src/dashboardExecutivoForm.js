// Formulário de lançamento diário do Dashboard Executivo — 5 etapas:
// Situação -> Desempenho -> Financeiro -> Conferência -> Finalização.
// Prévias client-side espelham as fórmulas do backend (dashboardExecutivo.calc.js)
// só para exibição; o valor autoritativo é sempre o que o servidor recalcula.
import { el, escapeHtml, toast, fmtMoeda, fmtPct } from "./utils.js";
import { pode } from "./sessao.js";
import { dashExecLancamento, dashExecCriarLancamento, dashExecAtualizarLancamento } from "./api.js";

const MOTIVOS_SEM_OPERACAO = ["Folga", "Feriado", "Manutenção", "Problema operacional", "Falta de insumos", "Fechamento temporário", "Outro"];

let ov = null;
let fm = null;

function fecharOverlay() { ov?.remove(); ov = null; fm = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function abrirOverlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal dex-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

function camposPadrao() {
  return {
    situacao: "normal", motivoSemOperacao: "", observacao: "",
    qtdVendas: "", valorVendasBruto: "", novosClientes: "",
    valorVendasIfood: "", taxasComissoes: "", servicosPromocoes: "", taxasEntregadores: "", outrasDeducoes: "",
    justificativaAjuste: "",
  };
}

function camposDoLancamento(l) {
  return {
    situacao: l.situacao, motivoSemOperacao: l.motivoSemOperacao ?? "", observacao: l.observacao ?? "",
    qtdVendas: l.qtdVendas, valorVendasBruto: l.valorVendasBruto, novosClientes: l.novosClientes,
    valorVendasIfood: l.valorVendasIfood, taxasComissoes: l.taxasComissoes, servicosPromocoes: l.servicosPromocoes,
    taxasEntregadores: l.taxasEntregadores, outrasDeducoes: l.outrasDeducoes, justificativaAjuste: l.justificativaAjuste ?? "",
  };
}

export async function abrirLancamentoModal({ data, unidadeId, onSalvo }) {
  // abrirOverlay() fecha qualquer modal anterior (fecharOverlay zera `fm`) —
  // por isso o estado só é atribuído DEPOIS de abrir o overlay novo, nunca antes.
  const m = abrirOverlay(`<div class="estado"><div class="spinner"></div>Carregando…</div>`);
  fm = {
    data, unidadeId, onSalvo, passo: 1,
    modoCorrecao: false, lancamentoId: null, statusOriginal: null,
    motivoCorrecao: "", campos: camposPadrao(), avisos: [], confirmarAvisos: false, salvando: false,
  };
  try {
    const { data: resp } = await dashExecLancamento(data, { unidadeId: unidadeId || undefined });
    if (resp.lancamento) {
      fm.lancamentoId = resp.lancamento.id;
      fm.statusOriginal = resp.lancamento.status;
      fm.modoCorrecao = resp.lancamento.status === "finalizado";
      fm.campos = camposDoLancamento(resp.lancamento);
    } else if (!resp.disponibilidade.disponivel) {
      renderIndisponivel(m, resp.disponibilidade.motivo);
      return;
    }
    renderPasso(m);
  } catch (e) {
    renderIndisponivel(m, e.message);
  }
}

function renderIndisponivel(m, motivo) {
  m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
    <div class="estado erro"><span class="emoji">🔒</span><h3>Dia indisponível</h3><p>${escapeHtml(motivo)}</p></div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
}

const TITULOS_PASSO = ["", "Situação da operação", "Desempenho", "Financeiro", "Conferência", "Finalização"];

function renderPasso(m) {
  const corpo = {
    1: passoSituacao, 2: passoDesempenho, 3: passoFinanceiro, 4: passoConferencia,
  }[fm.passo] ?? passoConferencia;

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>🗓️ Lançamento diário — ${fmtDataBr(fm.data)}</h2>
      <div class="modal-tags">
        <span class="chip">Etapa ${fm.passo}/4 · ${TITULOS_PASSO[fm.passo]}</span>
        ${fm.modoCorrecao ? `<span class="chip chip-unidade">Correção de lançamento finalizado</span>` : ""}
      </div>
    </div>
    <div class="dex-stepper">${[1, 2, 3, 4].map((p) => `<span class="dex-step ${p === fm.passo ? "ativo" : p < fm.passo ? "feito" : ""}">${p}</span>`).join("")}</div>
    <div class="dex-form-corpo">${corpo()}</div>
    <div class="ed-acoes dex-form-acoes">
      ${fm.passo > 1 ? `<button class="btn btn-ghost" id="dex-f-voltar">Voltar</button>` : `<button class="btn btn-ghost" id="dex-f-cancelar">Cancelar</button>`}
      ${fm.passo < 4 ? `<button class="btn btn-primary" id="dex-f-avancar">Avançar</button>` : botoesFinalizacao()}
    </div>`;

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-f-cancelar")?.addEventListener("click", fecharOverlay);
  m.querySelector("#dex-f-voltar")?.addEventListener("click", () => { fm.passo--; renderPasso(m); });
  m.querySelector("#dex-f-avancar")?.addEventListener("click", () => { if (validarPassoAtual(m)) { fm.passo++; renderPasso(m); } });
  wirePasso(m);
  if (fm.passo === 4) wireFinalizacao(m);
}

function botoesFinalizacao() {
  return `
    ${!fm.modoCorrecao ? `<button class="btn btn-ghost" id="dex-f-rascunho">Salvar como rascunho</button>` : ""}
    <button class="btn btn-primary" id="dex-f-finalizar">${fm.modoCorrecao ? "Salvar correção" : "Finalizar lançamento"}</button>`;
}

// ---------------------------------------------------------------------------
// ETAPA 1 — SITUAÇÃO
// ---------------------------------------------------------------------------
function passoSituacao() {
  const c = fm.campos;
  return `
    <p class="dex-form-pergunta">A unidade funcionou normalmente neste dia?</p>
    <div class="dex-radios">
      <label class="dex-radio"><input type="radio" name="situacao" value="normal" ${c.situacao === "normal" ? "checked" : ""}> Sim, funcionou normalmente</label>
      <label class="dex-radio"><input type="radio" name="situacao" value="sem_operacao" ${c.situacao === "sem_operacao" ? "checked" : ""}> Não funcionou</label>
      <label class="dex-radio"><input type="radio" name="situacao" value="zero_vendas" ${c.situacao === "zero_vendas" ? "checked" : ""}> Funcionou, mas não teve vendas</label>
    </div>
    <div id="dex-sem-op" ${c.situacao === "sem_operacao" ? "" : "hidden"}>
      <label class="cfg-campo"><span>Motivo *</span>
        <select id="dex-motivo">${MOTIVOS_SEM_OPERACAO.map((mo) => `<option ${c.motivoSemOperacao === mo ? "selected" : ""}>${mo}</option>`).join("")}</select>
      </label>
    </div>
    <label class="cfg-campo"><span>Observação (opcional)</span><input type="text" id="dex-obs" value="${escapeHtml(c.observacao)}"></label>`;
}

// ---------------------------------------------------------------------------
// ETAPA 2 — DESEMPENHO
// ---------------------------------------------------------------------------
function passoDesempenho() {
  const c = fm.campos;
  if (c.situacao !== "normal") {
    return `<p class="dex-form-info">Situação "${c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas"}" — os campos de desempenho e financeiro ficam zerados automaticamente.</p>`;
  }
  const ticket = ticketMedioPreview(c);
  return `
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Quantidade total de vendas *</span><input type="number" min="0" step="1" id="dex-qtd" value="${c.qtdVendas}"></label>
      <label class="cfg-campo"><span>Valor bruto total das vendas (R$) *</span><input type="number" min="0" step="0.01" id="dex-valorbruto" value="${c.valorVendasBruto}"></label>
      <label class="cfg-campo"><span>Novos clientes</span><input type="number" min="0" step="1" id="dex-novos" value="${c.novosClientes}"></label>
      <label class="cfg-campo"><span>Ticket médio (calculado)</span><input type="text" value="${ticket == null ? "—" : fmtMoeda(ticket)}" disabled></label>
    </div>`;
}

function ticketMedioPreview(c) {
  const q = Number(c.qtdVendas) || 0;
  const v = Number(c.valorVendasBruto) || 0;
  return q > 0 ? v / q : null;
}

// ---------------------------------------------------------------------------
// ETAPA 3 — FINANCEIRO
// ---------------------------------------------------------------------------
function passoFinanceiro() {
  const c = fm.campos;
  if (c.situacao !== "normal") return `<p class="dex-form-info">Sem valores financeiros para esta situação.</p>`;
  const podeNegativo = pode("dashboard_executivo.corrigir");
  const calc = calculoPreview(c);
  return `
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Valor das vendas no financeiro do iFood (R$) *</span><input type="number" min="0" step="0.01" id="dex-vifood" value="${c.valorVendasIfood}"></label>
      <label class="cfg-campo"><span>Taxas e comissões (R$) *</span><input type="number" min="0" step="0.01" id="dex-taxas" value="${c.taxasComissoes}"></label>
      <label class="cfg-campo"><span>Serviços e promoções (R$) *</span><input type="number" min="0" step="0.01" id="dex-servicos" value="${c.servicosPromocoes}"></label>
      <label class="cfg-campo"><span>Taxas de entregadores da loja (R$) *</span><input type="number" min="0" step="0.01" id="dex-entregadores" value="${c.taxasEntregadores}"></label>
      <label class="cfg-campo"><span>Outras deduções/ajustes (R$)${podeNegativo ? " — negativo = ajuste a favor" : ""}</span>
        <input type="number" step="0.01" id="dex-outras" value="${c.outrasDeducoes}" ${podeNegativo ? "" : "min=\"0\""}></label>
      ${podeNegativo ? `<label class="cfg-campo ed-campo-full"><span>Justificativa do ajuste (obrigatória se negativo)</span><input type="text" id="dex-justificativa" value="${escapeHtml(c.justificativaAjuste)}"></label>` : ""}
    </div>
    <div class="dex-calc-preview">
      <div><span>% Taxas e comissões</span><b>${fmtPct(calc.pctTaxas)}</b></div>
      <div><span>% Serviços e promoções</span><b>${fmtPct(calc.pctServicos)}</b></div>
      <div><span>% Taxas de entregadores</span><b>${fmtPct(calc.pctEntregadores)}</b></div>
      <div><span>Total de deduções</span><b>${fmtMoeda(calc.totalDed)}</b></div>
      <div><span>% Total de deduções</span><b>${fmtPct(calc.pctTotal)}</b></div>
      <div class="destaque"><span>Receita após deduções</span><b>${fmtMoeda(calc.receita)}</b></div>
    </div>`;
}

function calculoPreview(c) {
  const base = Number(c.valorVendasIfood) || 0;
  const taxas = Number(c.taxasComissoes) || 0;
  const servicos = Number(c.servicosPromocoes) || 0;
  const entreg = Number(c.taxasEntregadores) || 0;
  const outras = Number(c.outrasDeducoes) || 0;
  const totalDed = taxas + servicos + entreg + outras;
  const pct = (v) => (base > 0 ? (v / base) * 100 : null);
  return {
    pctTaxas: pct(taxas), pctServicos: pct(servicos), pctEntregadores: pct(entreg),
    totalDed, pctTotal: pct(totalDed), receita: base - totalDed,
  };
}

// ---------------------------------------------------------------------------
// ETAPA 4 — CONFERÊNCIA
// ---------------------------------------------------------------------------
function passoConferencia() {
  const c = fm.campos;
  const linha = (l, v) => `<div class="dex-conf-item"><span>${l}</span><b>${v}</b></div>`;
  const avisos = calcularAvisos(c);
  fm.avisos = avisos;
  if (c.situacao !== "normal") {
    return `
      <div class="dex-conf-grid">
        ${linha("Situação", c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas")}
        ${c.situacao === "sem_operacao" ? linha("Motivo", escapeHtml(c.motivoSemOperacao)) : ""}
        ${linha("Observação", escapeHtml(c.observacao || "—"))}
      </div>
      ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
  }
  const calc = calculoPreview(c);
  return `
    <div class="dex-conf-grid">
      ${linha("Quantidade de vendas", c.qtdVendas)}
      ${linha("Novos clientes", c.novosClientes || 0)}
      ${linha("Vendas brutas", fmtMoeda(c.valorVendasBruto))}
      ${linha("Ticket médio", fmtMoeda(ticketMedioPreview(c)))}
      ${linha("Valor das vendas (iFood)", fmtMoeda(c.valorVendasIfood))}
      ${linha("Taxas e comissões", `${fmtMoeda(c.taxasComissoes)} (${fmtPct(calc.pctTaxas)})`)}
      ${linha("Serviços e promoções", `${fmtMoeda(c.servicosPromocoes)} (${fmtPct(calc.pctServicos)})`)}
      ${linha("Taxas de entregadores", `${fmtMoeda(c.taxasEntregadores)} (${fmtPct(calc.pctEntregadores)})`)}
      ${linha("Outras deduções", fmtMoeda(c.outrasDeducoes))}
      ${linha("Total de deduções", `${fmtMoeda(calc.totalDed)} (${fmtPct(calc.pctTotal)})`)}
      ${linha("Receita após deduções", fmtMoeda(calc.receita))}
    </div>
    ${avisos.length ? `
      <div class="dex-avisos">
        <b>⚠️ Inconsistências encontradas:</b>
        <ul>${avisos.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>
        <label class="dex-radio"><input type="checkbox" id="dex-confirmar-avisos" ${fm.confirmarAvisos ? "checked" : ""}> Estou ciente e confirmo os valores mesmo assim.</label>
      </div>` : ""}
    ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
}

function campoMotivoCorrecao() {
  return `<label class="cfg-campo ed-campo-full dex-motivo-correcao"><span>Motivo da correção (obrigatório) *</span>
    <input type="text" id="dex-motivo-correcao" value="${escapeHtml(fm.motivoCorrecao)}" placeholder="Explique por que este lançamento finalizado está sendo alterado"></label>`;
}

function calcularAvisos(c) {
  if (c.situacao !== "normal") return [];
  const avisos = [];
  const q = Number(c.qtdVendas) || 0;
  const v = Number(c.valorVendasBruto) || 0;
  if (v > 0 && q === 0) avisos.push("Há valor de vendas informado, mas a quantidade de vendas está zerada.");
  if (q > 0 && v === 0) avisos.push("Há quantidade de vendas informada, mas o valor bruto está zerado.");
  const calc = calculoPreview(c);
  if (calc.totalDed > (Number(c.valorVendasIfood) || 0)) avisos.push("O total de deduções ultrapassa o valor das vendas do iFood.");
  return avisos;
}

// ---------------------------------------------------------------------------
// LEITURA DOS CAMPOS DO DOM -> fm.campos
// ---------------------------------------------------------------------------
function wirePasso(m) {
  if (fm.passo === 1) {
    m.querySelectorAll('input[name="situacao"]').forEach((r) => r.addEventListener("change", (e) => {
      fm.campos.situacao = e.target.value;
      m.querySelector("#dex-sem-op").hidden = e.target.value !== "sem_operacao";
    }));
    m.querySelector("#dex-motivo")?.addEventListener("change", (e) => { fm.campos.motivoSemOperacao = e.target.value; });
    m.querySelector("#dex-obs")?.addEventListener("input", (e) => { fm.campos.observacao = e.target.value; });
  }
  if (fm.passo === 2 && fm.campos.situacao === "normal") {
    const bind = (id, campo) => m.querySelector(id)?.addEventListener("input", (e) => { fm.campos[campo] = e.target.value; atualizarPreviewTicket(m); });
    bind("#dex-qtd", "qtdVendas"); bind("#dex-valorbruto", "valorVendasBruto"); bind("#dex-novos", "novosClientes");
  }
  if (fm.passo === 3 && fm.campos.situacao === "normal") {
    const campos = ["dex-vifood:valorVendasIfood", "dex-taxas:taxasComissoes", "dex-servicos:servicosPromocoes", "dex-entregadores:taxasEntregadores", "dex-outras:outrasDeducoes"];
    campos.forEach((par) => {
      const [id, campo] = par.split(":");
      m.querySelector(`#${id}`)?.addEventListener("input", (e) => { fm.campos[campo] = e.target.value; atualizarPreviewFinanceiro(m); });
    });
    m.querySelector("#dex-justificativa")?.addEventListener("input", (e) => { fm.campos.justificativaAjuste = e.target.value; });
  }
  if (fm.passo === 4) {
    m.querySelector("#dex-confirmar-avisos")?.addEventListener("change", (e) => { fm.confirmarAvisos = e.target.checked; });
    m.querySelector("#dex-motivo-correcao")?.addEventListener("input", (e) => { fm.motivoCorrecao = e.target.value; });
  }
}

function atualizarPreviewTicket(m) {
  const val = ticketMedioPreview(fm.campos);
  const alvo = m.querySelector(".dex-form-corpo input[disabled]");
  if (alvo) alvo.value = val == null ? "—" : fmtMoeda(val);
}

function atualizarPreviewFinanceiro(m) {
  const calc = calculoPreview(fm.campos);
  const box = m.querySelector(".dex-calc-preview");
  if (!box) return;
  const valores = box.querySelectorAll("b");
  valores[0].textContent = fmtPct(calc.pctTaxas);
  valores[1].textContent = fmtPct(calc.pctServicos);
  valores[2].textContent = fmtPct(calc.pctEntregadores);
  valores[3].textContent = fmtMoeda(calc.totalDed);
  valores[4].textContent = fmtPct(calc.pctTotal);
  valores[5].textContent = fmtMoeda(calc.receita);
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO CLIENT-SIDE MÍNIMA (a autoritativa é sempre o backend)
// ---------------------------------------------------------------------------
function validarPassoAtual(m) {
  const c = fm.campos;
  if (fm.passo === 1) {
    if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) {
      c.motivoSemOperacao = m.querySelector("#dex-motivo")?.value || "";
    }
    if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) { toast("Informe o motivo de não operação."); return false; }
    return true;
  }
  if (fm.passo === 2 && c.situacao === "normal") {
    if (c.qtdVendas === "" || c.valorVendasBruto === "") { toast("Preencha a quantidade e o valor bruto das vendas."); return false; }
    if (Number(c.qtdVendas) < 0 || Number(c.valorVendasBruto) < 0) { toast("Valores não podem ser negativos."); return false; }
    return true;
  }
  if (fm.passo === 3 && c.situacao === "normal") {
    if ([c.valorVendasIfood, c.taxasComissoes, c.servicosPromocoes, c.taxasEntregadores].some((v) => v === "")) {
      toast("Preencha todos os campos financeiros obrigatórios."); return false;
    }
    if (Number(c.outrasDeducoes) < 0 && !pode("dashboard_executivo.corrigir")) {
      toast("Você não tem permissão para lançar um ajuste negativo."); return false;
    }
    if (Number(c.outrasDeducoes) < 0 && !c.justificativaAjuste?.trim()) {
      toast("Informe a justificativa do ajuste negativo."); return false;
    }
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// FINALIZAÇÃO — salvar rascunho / finalizar / corrigir
// ---------------------------------------------------------------------------
function wireFinalizacao(m) {
  m.querySelector("#dex-f-rascunho")?.addEventListener("click", () => salvar(m, "rascunho"));
  m.querySelector("#dex-f-finalizar")?.addEventListener("click", () => salvar(m, "finalizado"));
}

function payloadBase(status) {
  const c = fm.campos;
  const base = {
    unidadeId: fm.unidadeId || undefined, data: fm.data, situacao: c.situacao,
    observacao: c.observacao || undefined, status,
  };
  if (c.situacao === "sem_operacao") return { ...base, motivoSemOperacao: c.motivoSemOperacao };
  if (c.situacao === "zero_vendas") return { ...base, novosClientes: Number(c.novosClientes) || 0 };
  return {
    ...base,
    qtdVendas: Number(c.qtdVendas) || 0, valorVendasBruto: Number(c.valorVendasBruto) || 0, novosClientes: Number(c.novosClientes) || 0,
    valorVendasIfood: Number(c.valorVendasIfood) || 0, taxasComissoes: Number(c.taxasComissoes) || 0,
    servicosPromocoes: Number(c.servicosPromocoes) || 0, taxasEntregadores: Number(c.taxasEntregadores) || 0,
    outrasDeducoes: Number(c.outrasDeducoes) || 0, justificativaAjuste: c.justificativaAjuste || undefined,
    confirmarAvisos: fm.confirmarAvisos,
  };
}

async function salvar(m, status) {
  if (fm.modoCorrecao && !fm.motivoCorrecao.trim()) { toast("Informe o motivo da correção."); return; }
  const btn = m.querySelector(status === "finalizado" ? "#dex-f-finalizar" : "#dex-f-rascunho");
  if (!btn || fm.salvando) return;
  fm.salvando = true;
  const txt = btn.textContent; btn.disabled = true; btn.textContent = "Salvando…";
  try {
    const payload = payloadBase(status);
    if (fm.lancamentoId) {
      await dashExecAtualizarLancamento(fm.lancamentoId, { ...payload, motivo: fm.modoCorrecao ? fm.motivoCorrecao : undefined });
    } else {
      await dashExecCriarLancamento(payload);
    }
    toast(status === "finalizado" ? "Lançamento finalizado ✅" : "Rascunho salvo.");
    const onSalvo = fm?.onSalvo; // capturado ANTES de fechar: fecharOverlay() zera `fm`
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = txt;
    fm.salvando = false;
  }
}

function fmtDataBr(iso) {
  if (!iso) return "—";
  const [a, mes, d] = iso.split("-");
  return `${d}/${mes}/${a}`;
}
