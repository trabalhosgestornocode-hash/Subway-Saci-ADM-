// Formulário de lançamento diário do Dashboard Executivo — 5 etapas:
// Situação -> Desempenho -> Financeiro -> Conferência -> Finalização.
// Prévias client-side espelham as fórmulas do backend (dashboardExecutivo.calc.js)
// só para exibição; o valor autoritativo é sempre o que o servidor recalcula.
import { el, escapeHtml, toast, fmtMoeda, fmtPct } from "./utils.js";
import { pode } from "./sessao.js";
import {
  dashExecLancamento, dashExecCriarLancamento, dashExecAtualizarLancamento,
  dashExecPreviewResetTeste, dashExecConfirmarResetTeste, dashExecExcluirLancamento,
} from "./api.js";

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
    // Desempenho é opcional: um valor null (não informado) vira campo VAZIO
    // no input, nunca "null" literal nem 0 — ver dashboardExecutivo.calc.js.
    qtdVendas: l.qtdVendas ?? "", valorVendasBruto: l.valorVendasBruto ?? "", novosClientes: l.novosClientes ?? "",
    // Financeiro TAMBÉM pode vir null agora — um rascunho de dia ≠ ontem
    // ainda não tem esse dado (ver dashboardExecutivo.service.js#normalizarDadosLancamento).
    valorVendasIfood: l.valorVendasIfood ?? "", taxasComissoes: l.taxasComissoes ?? "", servicosPromocoes: l.servicosPromocoes ?? "",
    taxasEntregadores: l.taxasEntregadores ?? "", outrasDeducoes: l.outrasDeducoes ?? "", justificativaAjuste: l.justificativaAjuste ?? "",
  };
}

// Full Service: a entrega é sempre feita pelo parceiro do iFood — não existe
// "taxas de entregadores da loja" nesse modelo (mesma regra de negócio de
// dashboardExecutivo.calc.js#INDICADORES_POR_MODELO, espelhada aqui só para
// exibição/validação do formulário).
function mostraEntregadores() {
  return fm.modeloLogistico !== "full_service";
}

export async function abrirLancamentoModal({ data, unidadeId, modeloLogistico, ehTeste, onSalvo }) {
  // abrirOverlay() fecha qualquer modal anterior (fecharOverlay zera `fm`) —
  // por isso o estado só é atribuído DEPOIS de abrir o overlay novo, nunca antes.
  const m = abrirOverlay(`<div class="estado"><div class="spinner"></div>Carregando…</div>`);
  fm = {
    data, unidadeId, modeloLogistico, ehTeste: !!ehTeste, onSalvo, passo: 1,
    modoCorrecao: false, lancamentoId: null, statusOriginal: null,
    motivoCorrecao: "", campos: camposPadrao(), avisos: [], confirmarAvisos: false, salvando: false,
    // Autoridade é sempre o servidor (ver obterLancamentoPorData/financeiroDisponivelNaData
    // no backend) — valores por omissão aqui só cobrem o instante antes da
    // resposta chegar, nunca usados pra decidir nada sozinhos.
    mostrarFinanceiro: true, periodoFinanceiroInicio: data, periodoFinanceiroFim: data,
  };
  try {
    const { data: resp } = await dashExecLancamento(data, { unidadeId: unidadeId || undefined });
    fm.mostrarFinanceiro = resp.mostrarFinanceiro;
    fm.periodoFinanceiroInicio = resp.periodoFinanceiroInicio;
    fm.periodoFinanceiroFim = resp.periodoFinanceiroFim;
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

// ---------------------------------------------------------------------------
// RESET DE DIA (SÓ EM UNIDADE DE TESTE) — troca o corpo do modal pra uma tela
// de confirmação separada do fluxo normal de edição/correção. O botão que
// leva aqui (renderPasso) só aparece quando fm.ehTeste — mas quem garante de
// verdade é o backend (revalida eh_teste a cada chamada).
// ---------------------------------------------------------------------------
async function renderResetPreview(m) {
  m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>🧪 Resetar dia para teste</h2></div>
    <div class="estado"><div class="spinner"></div>Verificando lançamentos…</div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  try {
    const { data } = await dashExecPreviewResetTeste(fm.unidadeId, fm.data);
    renderResetConfirmacao(m, data);
  } catch (e) {
    m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
      <div class="estado erro"><span class="emoji">⚠️</span><h3>Não foi possível resetar</h3><p>${escapeHtml(e.message)}</p></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  }
}

function renderResetConfirmacao(m, preview) {
  const datas = preview.lancamentos.map((l) => l.data);
  const multiplos = datas.length > 1;
  const corpo = multiplos
    ? `<p><b>RESETAR LANÇAMENTOS DE TESTE</b></p>
       <p>Ao resetar ${fmtDataBr(preview.dataAlvo)}, os seguintes lançamentos posteriores também precisarão ser removidos — isso é necessário para preservar a ordem sequencial:</p>
       <ul class="dex-reset-lista">${datas.map((d) => `<li>${fmtDataBr(d)}</li>`).join("")}</ul>`
    : `<p><b>RESETAR DIA PARA TESTE</b></p>
       <p>Você está prestes a remover o lançamento de ${fmtDataBr(preview.dataAlvo)}. Após o reset, essa data volta a aparecer como pendente.</p>`;

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>🧪 Resetar dia para teste</h2></div>
    <div class="dex-avisos dex-avisos-perigo">${corpo}</div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="dex-reset-cancelar">Cancelar</button>
      <button class="btn btn-perigo" id="dex-reset-confirmar">${multiplos ? "Resetar a partir desta data" : "Resetar dia"}</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-reset-cancelar").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-reset-confirmar").addEventListener("click", () => confirmarReset(m, preview.dataAlvo));
}

async function confirmarReset(m, dataAlvo) {
  const btn = m.querySelector("#dex-reset-confirmar");
  const unidadeId = fm.unidadeId; // captura antes: fecharOverlay() zera `fm`
  const onSalvo = fm.onSalvo;
  btn.disabled = true; btn.textContent = "Resetando…";
  try {
    await dashExecConfirmarResetTeste(unidadeId, dataAlvo);
    toast("Lançamento(s) resetado(s) para teste.");
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Resetar dia";
  }
}

const TITULOS_PASSO = {
  situacao: "Situação da operação", desempenho: "Desempenho (opcional)",
  financeiro: "Financeiro", conferencia: "Conferência",
};
const CORPO_PASSO = {
  situacao: passoSituacao, desempenho: passoDesempenho, financeiro: passoFinanceiro, conferencia: passoConferencia,
};

// Lista de etapas ATIVAS pra este lançamento — muda com a situação (radio da
// etapa 1) e com `fm.mostrarFinanceiro` (decidido pelo servidor, ver
// abrirLancamentoModal). Financeiro só entra pra situação "normal" quando a
// data lançada é ontem (ou já tem snapshot salvo); pras demais situações
// (sem_operacao/zero_vendas) continua sempre presente — comportamento
// inalterado, fora do escopo deste ajuste.
function passosAtivos() {
  const passos = ["situacao", "desempenho"];
  if (fm.campos.situacao !== "normal" || fm.mostrarFinanceiro) passos.push("financeiro");
  passos.push("conferencia");
  return passos;
}

function renderPasso(m) {
  const passos = passosAtivos();
  // Nunca deixa `fm.passo` apontar além do fim (pode acontecer se o usuário
  // trocou a situação numa sessão em que financeiro ainda contava como etapa).
  if (fm.passo > passos.length) fm.passo = passos.length;
  const chave = passos[fm.passo - 1];
  const corpo = CORPO_PASSO[chave];

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>🗓️ Lançamento diário — ${fmtDataBr(fm.data)}</h2>
      <div class="modal-tags">
        <span class="chip">Etapa ${fm.passo}/${passos.length} · ${TITULOS_PASSO[chave]}</span>
        ${fm.modoCorrecao ? `<span class="chip chip-unidade">Correção de lançamento finalizado</span>` : ""}
      </div>
      ${fm.ehTeste && fm.lancamentoId ? `<button class="btn btn-ghost btn-sm dex-btn-reset-teste" id="dex-abrir-reset-teste" type="button">🧪 Resetar dia para teste</button>` : ""}
      ${podeExcluir() && fm.lancamentoId ? `<button class="btn btn-ghost btn-sm dex-btn-excluir" id="dex-abrir-exclusao" type="button">🗑️ Excluir lançamento</button>` : ""}
    </div>
    <div class="dex-stepper">${passos.map((_, i) => `<span class="dex-step ${i + 1 === fm.passo ? "ativo" : i + 1 < fm.passo ? "feito" : ""}">${i + 1}</span>`).join("")}</div>
    <div class="dex-form-corpo">${corpo()}</div>
    <div class="ed-acoes dex-form-acoes">
      ${fm.passo > 1 ? `<button class="btn btn-ghost" id="dex-f-voltar">Voltar</button>` : `<button class="btn btn-ghost" id="dex-f-cancelar">Cancelar</button>`}
      ${fm.passo < passos.length ? `<button class="btn btn-primary" id="dex-f-avancar">Avançar</button>` : botoesFinalizacao()}
    </div>`;

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-f-cancelar")?.addEventListener("click", fecharOverlay);
  m.querySelector("#dex-f-voltar")?.addEventListener("click", () => { fm.passo--; renderPasso(m); });
  m.querySelector("#dex-f-avancar")?.addEventListener("click", () => { if (validarPassoAtual(m)) { fm.passo++; renderPasso(m); } });
  m.querySelector("#dex-abrir-reset-teste")?.addEventListener("click", () => renderResetPreview(m));
  m.querySelector("#dex-abrir-exclusao")?.addEventListener("click", () => renderExclusaoConfirmacao(m));
  wirePasso(m, chave);
  if (chave === "conferencia") wireFinalizacao(m);
}

const podeExcluir = () => pode("dashboard_executivo.excluir");

// ---------------------------------------------------------------------------
// EXCLUSÃO UNIVERSAL (real ou teste) — só administrador. Sempre pede motivo,
// sempre confirma antes de apagar de verdade.
// ---------------------------------------------------------------------------
function renderExclusaoConfirmacao(m) {
  const c = fm.campos;
  const resumo = c.situacao === "normal"
    ? `Valor das vendas (iFood): ${fmtMoeda(c.valorVendasIfood)}`
    : c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas";
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>🗑️ Excluir lançamento — ${fmtDataBr(fm.data)}</h2></div>
    <div class="dex-avisos dex-avisos-perigo">
      <p><b>Esta ação apaga o lançamento deste dia definitivamente.</b></p>
      <div class="dex-conf-grid">
        <div class="dex-conf-item"><span>Data</span><b>${fmtDataBr(fm.data)}</b></div>
        <div class="dex-conf-item"><span>Situação</span><b>${escapeHtml(resumo)}</b></div>
      </div>
      <p>O registro completo fica guardado no log de exclusões (com seu usuário e o motivo abaixo) — mas o lançamento em si sai da grade e dos totais do mês.</p>
    </div>
    <label class="cfg-campo ed-campo-full"><span>Motivo da exclusão (obrigatório) *</span>
      <input type="text" id="dex-excl-motivo" placeholder="Explique por que este lançamento está sendo apagado"></label>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="dex-excl-cancelar">Cancelar</button>
      <button class="btn btn-perigo" id="dex-excl-confirmar">Excluir definitivamente</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-excl-cancelar").addEventListener("click", () => renderPasso(m));
  m.querySelector("#dex-excl-confirmar").addEventListener("click", () => confirmarExclusao(m));
}

async function confirmarExclusao(m) {
  const motivo = m.querySelector("#dex-excl-motivo")?.value.trim() || "";
  if (motivo.length < 3) { toast("Informe o motivo da exclusão (mínimo 3 caracteres)."); return; }
  const btn = m.querySelector("#dex-excl-confirmar");
  const lancamentoId = fm.lancamentoId;
  const unidadeId = fm.unidadeId; // captura antes: fecharOverlay() zera `fm`
  const onSalvo = fm.onSalvo;
  btn.disabled = true; btn.textContent = "Excluindo…";
  try {
    await dashExecExcluirLancamento(lancamentoId, { unidadeId: unidadeId || undefined, motivo });
    toast("Lançamento excluído.");
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Excluir definitivamente";
  }
}

function botoesFinalizacao() {
  // Sem financeiro disponível (dia "normal" ≠ ontem, sem snapshot salvo), só
  // dá pra salvar como rascunho — o backend recusa finalizar sem o valor das
  // vendas do iFood (ver dashboardExecutivo.service.js#normalizarDadosLancamento).
  // Numa correção (fm.modoCorrecao), o registro já É finalizado e portanto
  // já TEM o financeiro pelo mesmo invariante — mostrarFinanceiro vem true.
  const podeFinalizar = fm.campos.situacao !== "normal" || fm.mostrarFinanceiro;
  return `
    ${!fm.modoCorrecao ? `<button class="btn btn-ghost" id="dex-f-rascunho">Salvar como rascunho</button>` : ""}
    ${podeFinalizar
      ? `<button class="btn btn-primary" id="dex-f-finalizar">${fm.modoCorrecao ? "Salvar correção" : "Finalizar lançamento"}</button>`
      : ""}`;
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
    <p class="dex-form-info">📎 Dados complementares — preencha caso tenha acesso às informações. Nada aqui é obrigatório: o que ficar em branco fica registrado como "não informado", nunca como zero.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Quantidade total de vendas</span><input type="number" min="0" step="1" id="dex-qtd" value="${c.qtdVendas}" placeholder="Não informado"></label>
      <label class="cfg-campo"><span>Valor bruto total das vendas (R$)</span><input type="number" min="0" step="0.01" id="dex-valorbruto" value="${c.valorVendasBruto}" placeholder="Não informado"></label>
      <label class="cfg-campo"><span>Novos clientes</span><input type="number" min="0" step="1" id="dex-novos" value="${c.novosClientes}" placeholder="Não informado"></label>
      <label class="cfg-campo"><span>Ticket médio (calculado)</span><input type="text" value="${ticket == null ? "—" : fmtMoeda(ticket)}" disabled></label>
    </div>`;
}

/** Ticket médio só existe quando os DOIS lados são conhecidos — nunca finge
 * "R$ 0,00" quando falta um dos dois (ver dashboardExecutivo.calc.js#ticketMedio). */
function ticketMedioPreview(c) {
  if (c.qtdVendas === "" || c.valorVendasBruto === "") return null;
  const q = Number(c.qtdVendas);
  const v = Number(c.valorVendasBruto);
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
  const mostrarEntreg = mostraEntregadores();
  return `
    <p class="dex-form-info">📅 Financeiro acumulado do mês até aqui — dados consolidados de ${fmtDataBr(fm.periodoFinanceiroInicio)} até ${fmtDataBr(fm.periodoFinanceiroFim)}, o extrato que o iFood libera hoje.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Valor das vendas no financeiro do iFood (R$) *</span><input type="number" min="0" step="0.01" id="dex-vifood" value="${c.valorVendasIfood}"></label>
      <label class="cfg-campo"><span>Taxas e comissões (R$) *</span><input type="number" min="0" step="0.01" id="dex-taxas" value="${c.taxasComissoes}"></label>
      <label class="cfg-campo"><span>Serviços e promoções (R$) *</span><input type="number" min="0" step="0.01" id="dex-servicos" value="${c.servicosPromocoes}"></label>
      ${mostrarEntreg
        ? `<label class="cfg-campo"><span>Taxas de entregadores da loja (R$) *</span><input type="number" min="0" step="0.01" id="dex-entregadores" value="${c.taxasEntregadores}"></label>`
        : `<p class="dex-form-info dex-form-na">🛵 Este modelo (Full Service) não usa entregador próprio — a entrega é feita pelo parceiro do iFood, então não há "taxas de entregadores da loja" a lançar.</p>`}
      <label class="cfg-campo"><span>Outras deduções/ajustes (R$)${podeNegativo ? " — negativo = ajuste a favor" : ""}</span>
        <input type="number" step="0.01" id="dex-outras" value="${c.outrasDeducoes}" ${podeNegativo ? "" : "min=\"0\""}></label>
      ${podeNegativo ? `<label class="cfg-campo ed-campo-full"><span>Justificativa do ajuste (obrigatória se negativo)</span><input type="text" id="dex-justificativa" value="${escapeHtml(c.justificativaAjuste)}"></label>` : ""}
    </div>
    <div class="dex-calc-preview">
      <div><span>% Taxas e comissões</span><b data-prev="taxas">${fmtPct(calc.pctTaxas)}</b></div>
      <div><span>% Serviços e promoções</span><b data-prev="servicos">${fmtPct(calc.pctServicos)}</b></div>
      ${mostrarEntreg ? `<div><span>% Taxas de entregadores</span><b data-prev="entregadores">${fmtPct(calc.pctEntregadores)}</b></div>` : ""}
      <div><span>Total de deduções</span><b data-prev="total">${fmtMoeda(calc.totalDed)}</b></div>
      <div><span>% Total de deduções</span><b data-prev="pctTotal">${fmtPct(calc.pctTotal)}</b></div>
      <div class="destaque"><span>Receita após deduções</span><b data-prev="receita">${fmtMoeda(calc.receita)}</b></div>
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
  if (c.situacao !== "normal") {
    fm.avisos = [];
    return `
      <div class="dex-conf-grid">
        ${linha("Situação", c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas")}
        ${c.situacao === "sem_operacao" ? linha("Motivo", escapeHtml(c.motivoSemOperacao)) : ""}
        ${linha("Observação", escapeHtml(c.observacao || "—"))}
      </div>
      ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
  }

  // Financeiro não fez parte deste lançamento (dia ≠ ontem, sem snapshot
  // salvo) — item "SE O DIA NÃO FOR ONTEM" do pedido: nunca mostra os
  // campos financeiros vazios/zerados, só avisa que fica como rascunho.
  if (!fm.mostrarFinanceiro) {
    fm.avisos = [];
    return `
      <div class="dex-conf-grid">
        ${linha("Quantidade de vendas", c.qtdVendas === "" ? "—" : c.qtdVendas)}
        ${linha("Novos clientes", c.novosClientes === "" ? "—" : c.novosClientes)}
        ${linha("Vendas brutas", fmtMoeda(c.valorVendasBruto))}
        ${linha("Ticket médio", fmtMoeda(ticketMedioPreview(c)))}
      </div>
      <p class="dex-form-info">💰 Financeiro ainda não disponível — o iFood só consolida com 1 dia de atraso.
      Este lançamento fica como <b>rascunho</b>; reabra amanhã (quando esta data virar "ontem") para completar o
      Financeiro e finalizar.</p>
      ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
  }

  const avisos = calcularAvisos(c);
  fm.avisos = avisos;
  const calc = calculoPreview(c);
  return `
    <div class="dex-conf-grid">
      ${linha("Quantidade de vendas", c.qtdVendas === "" ? "—" : c.qtdVendas)}
      ${linha("Novos clientes", c.novosClientes === "" ? "—" : c.novosClientes)}
      ${linha("Vendas brutas", fmtMoeda(c.valorVendasBruto))}
      ${linha("Ticket médio", fmtMoeda(ticketMedioPreview(c)))}
      ${linha("Valor das vendas (iFood)", fmtMoeda(c.valorVendasIfood))}
      ${linha("Taxas e comissões", `${fmtMoeda(c.taxasComissoes)} (${fmtPct(calc.pctTaxas)})`)}
      ${linha("Serviços e promoções", `${fmtMoeda(c.servicosPromocoes)} (${fmtPct(calc.pctServicos)})`)}
      ${mostraEntregadores() ? linha("Taxas de entregadores", `${fmtMoeda(c.taxasEntregadores)} (${fmtPct(calc.pctEntregadores)})`) : ""}
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
function wirePasso(m, chave) {
  if (chave === "situacao") {
    m.querySelectorAll('input[name="situacao"]').forEach((r) => r.addEventListener("change", (e) => {
      fm.campos.situacao = e.target.value;
      m.querySelector("#dex-sem-op").hidden = e.target.value !== "sem_operacao";
    }));
    m.querySelector("#dex-motivo")?.addEventListener("change", (e) => { fm.campos.motivoSemOperacao = e.target.value; });
    m.querySelector("#dex-obs")?.addEventListener("input", (e) => { fm.campos.observacao = e.target.value; });
  }
  if (chave === "desempenho" && fm.campos.situacao === "normal") {
    const bind = (id, campo) => m.querySelector(id)?.addEventListener("input", (e) => { fm.campos[campo] = e.target.value; atualizarPreviewTicket(m); });
    bind("#dex-qtd", "qtdVendas"); bind("#dex-valorbruto", "valorVendasBruto"); bind("#dex-novos", "novosClientes");
  }
  if (chave === "financeiro" && fm.campos.situacao === "normal") {
    const campos = ["dex-vifood:valorVendasIfood", "dex-taxas:taxasComissoes", "dex-servicos:servicosPromocoes", "dex-entregadores:taxasEntregadores", "dex-outras:outrasDeducoes"];
    campos.forEach((par) => {
      const [id, campo] = par.split(":");
      m.querySelector(`#${id}`)?.addEventListener("input", (e) => { fm.campos[campo] = e.target.value; atualizarPreviewFinanceiro(m); });
    });
    m.querySelector("#dex-justificativa")?.addEventListener("input", (e) => { fm.campos.justificativaAjuste = e.target.value; });
  }
  if (chave === "conferencia") {
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
  const set = (chave, texto) => { const el = box.querySelector(`[data-prev="${chave}"]`); if (el) el.textContent = texto; };
  set("taxas", fmtPct(calc.pctTaxas));
  set("servicos", fmtPct(calc.pctServicos));
  set("entregadores", fmtPct(calc.pctEntregadores));
  set("total", fmtMoeda(calc.totalDed));
  set("pctTotal", fmtPct(calc.pctTotal));
  set("receita", fmtMoeda(calc.receita));
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO CLIENT-SIDE MÍNIMA (a autoritativa é sempre o backend)
// ---------------------------------------------------------------------------
function validarPassoAtual(m) {
  const c = fm.campos;
  const chave = passosAtivos()[fm.passo - 1];
  if (chave === "situacao") {
    if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) {
      c.motivoSemOperacao = m.querySelector("#dex-motivo")?.value || "";
    }
    if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) { toast("Informe o motivo de não operação."); return false; }
    return true;
  }
  if (chave === "desempenho" && c.situacao === "normal") {
    // Desempenho é opcional — nada aqui bloqueia o avanço. Só valida o que
    // foi de fato preenchido (não pode ser negativo).
    if (c.qtdVendas !== "" && Number(c.qtdVendas) < 0) { toast("A quantidade de vendas não pode ser negativa."); return false; }
    if (c.valorVendasBruto !== "" && Number(c.valorVendasBruto) < 0) { toast("O valor bruto não pode ser negativo."); return false; }
    return true;
  }
  // Financeiro só aparece nas etapas ativas quando fm.mostrarFinanceiro é
  // true (ver passosAtivos) — chegar aqui já implica que os campos existem
  // no DOM e são esperados preenchidos, exatamente como antes.
  if (chave === "financeiro" && c.situacao === "normal") {
    const obrigatorios = [c.valorVendasIfood, c.taxasComissoes, c.servicosPromocoes];
    if (mostraEntregadores()) obrigatorios.push(c.taxasEntregadores);
    else c.taxasEntregadores = c.taxasEntregadores || 0; // Full Service: campo nem aparece, garante 0 no cálculo/envio
    if (obrigatorios.some((v) => v === "")) {
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

/** "" (campo vazio) vira `undefined` (omitido do corpo) — nunca 0. O backend
 * trata ausência como "não informado" (null), nunca como zero digitado. */
const numOuIndefinido = (s) => (s === "" || s == null ? undefined : Number(s));

function payloadBase(status) {
  const c = fm.campos;
  const base = {
    unidadeId: fm.unidadeId || undefined, data: fm.data, situacao: c.situacao,
    observacao: c.observacao || undefined, status,
  };
  if (c.situacao === "sem_operacao") return { ...base, motivoSemOperacao: c.motivoSemOperacao };
  if (c.situacao === "zero_vendas") return { ...base, novosClientes: numOuIndefinido(c.novosClientes) };
  const desempenho = {
    // Desempenho: opcional, nunca vira 0 por conta própria.
    qtdVendas: numOuIndefinido(c.qtdVendas), valorVendasBruto: numOuIndefinido(c.valorVendasBruto), novosClientes: numOuIndefinido(c.novosClientes),
  };
  if (!fm.mostrarFinanceiro) {
    // Etapa Financeiro nem fez parte deste lançamento (dia ≠ ontem, sem
    // snapshot salvo) — não manda nada dela, nunca 0 (backend mantém null e
    // só deixa o dia virar rascunho, ver normalizarDadosLancamento).
    return { ...base, ...desempenho };
  }
  return {
    ...base, ...desempenho,
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
