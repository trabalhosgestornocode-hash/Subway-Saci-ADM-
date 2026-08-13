// Modal "Importar relatório Food Delivery" — 3 passos:
//   1. upload -> prévia de formato/período/quantidade (sem códigos ainda)
//   2. códigos "cancelado sem taxa" (chips, aceita colar vários) com
//      validação ao vivo contra a prévia + resumo recalculado a cada mudança
//   3. revisão final do resumo financeiro -> confirmar
// A leitura da planilha acontece sempre no BACKEND
// (parser-food-delivery/parserFoodDelivery.parser.js); o frontend só embala
// o arquivo em base64 e reenvia a cada chamada (mesma técnica de
// bonificacaoMensalImportModal.js) — nenhum estado de importação fica
// "pendente" no servidor entre os passos.
import { el, escapeHtml, toast, fmtMoeda, fmtDataHora } from "./utils.js";
import { pfdImportarPreview, pfdConciliarPreview, pfdConciliarConfirmar } from "./api.js";

let ov = null;
function fecharOverlay() { ov?.remove(); ov = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function overlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal bm-modal pfd-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

// ---------- arquivo -> base64 (mesma técnica de bonificacaoMensalImportModal.js) ----------
async function arquivoPayload(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCO));
  return { nomeArquivo: file.name, conteudoBase64: btoa(bin) };
}

const fmtDataBr = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const fmtPeriodo = (ini, fim) => (!ini ? "—" : ini === fim ? fmtDataBr(ini) : `${fmtDataBr(ini)} até ${fmtDataBr(fim)}`);

export function abrirImportarFoodDeliveryModal({ unidadeNome, onSalvo }) {
  const ctx = {
    etapa: 1, arquivoFile: null, payloadArquivo: null, previewArquivo: null,
    periodoManual: { inicio: "", fim: "" }, codigos: [], conciliacao: null, onSalvo,
  };

  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>⬆️ Importar relatório Food Delivery</h2><div class="modal-tags"><span class="chip">🏪 ${escapeHtml(unidadeNome || "—")}</span></div></div>
    <div class="pfd-imp-corpo"></div>`);
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);

  renderEtapa1(m, ctx);
}

// ---------------------------------------------------------------------------
// ETAPA 1 — upload + prévia de formato/período/quantidade
// ---------------------------------------------------------------------------
function renderEtapa1(m, ctx) {
  const corpo = m.querySelector(".pfd-imp-corpo");
  corpo.innerHTML = `
    <div class="bm-imp-form">
      <div class="bm-drop" id="pfd-drop">
        <div class="bm-drop-titulo">Relatório de pedidos (.xls ou .xlsx)</div>
        <p class="bm-drop-desc">Relatório detalhado de pedidos do food delivery — diário, semanal, mensal ou qualquer intervalo.</p>
        <div class="bm-drop-area" tabindex="0" role="button">
          <span class="bm-drop-icone">📄</span>
          <span class="bm-drop-txt">Arraste o arquivo aqui ou <u>selecione o arquivo</u></span>
          <em id="pfd-drop-nome">Nenhum arquivo selecionado</em>
        </div>
        <input type="file" id="pfd-drop-input" accept=".xls,.xlsx" hidden>
      </div>
      <div class="vd-imp-msg" id="pfd-imp-msg" hidden></div>
      <div id="pfd-preview-1"></div>
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="pfd-analisar" disabled>Analisar relatório</button>
    </div>`;

  m.querySelector("#pfd-cancelar").addEventListener("click", fecharOverlay);
  wireDropZone(m, "pfd-drop", (f) => {
    ctx.arquivoFile = f; ctx.previewArquivo = null;
    m.querySelector("#pfd-preview-1").innerHTML = "";
    m.querySelector("#pfd-analisar").disabled = false;
  });
  m.querySelector("#pfd-analisar").addEventListener("click", () => analisarArquivo(m, ctx));
}

function wireDropZone(m, id, onArquivo) {
  const zona = m.querySelector(`#${id}`);
  const area = zona.querySelector(".bm-drop-area");
  const input = zona.querySelector(`#${id}-input`);
  const nomeEl = zona.querySelector(`#${id}-nome`);
  const aplicar = (file) => {
    if (!file) return;
    if (!/\.(xls|xlsx)$/i.test(file.name)) { toast("Selecione um arquivo .xls ou .xlsx."); return; }
    nomeEl.textContent = file.name;
    zona.classList.add("preenchido");
    onArquivo(file);
  };
  area.addEventListener("click", () => input.click());
  area.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => aplicar(input.files?.[0]));
  ["dragenter", "dragover"].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("arrastando"); }));
  ["dragleave", "drop"].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("arrastando"); }));
  area.addEventListener("drop", (e) => aplicar(e.dataTransfer.files?.[0]));
}

async function analisarArquivo(m, ctx) {
  const msg = m.querySelector("#pfd-imp-msg");
  const setMsg = (t, cls = "erro") => { msg.hidden = false; msg.className = "vd-imp-msg " + cls; msg.textContent = t; };
  const btn = m.querySelector("#pfd-analisar");
  const txtOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = "Lendo arquivo…";
  try {
    ctx.payloadArquivo = await arquivoPayload(ctx.arquivoFile);
    const { data } = await pfdImportarPreview({ arquivo: ctx.payloadArquivo });
    ctx.previewArquivo = data;
    renderPreview1(m, ctx);
  } catch (e) {
    setMsg("Erro: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}

function renderPreview1(m, ctx) {
  const p = ctx.previewArquivo;
  const box = m.querySelector("#pfd-preview-1");
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  const situacoes = Object.entries(p.porSituacao || {}).map(([s, n]) => `${escapeHtml(s)}: ${n}`).join(" · ");
  const f = p.filtragem || {};
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Relatório lido com sucesso</div>
      <div class="vd-pv-grid">
        ${item("Arquivo original", escapeHtml(p.nomeArquivo || "—"))}
        ${item("Total de pedidos", p.totalPedidos)}
        ${item("Período analisado", p.periodoDetectado ? fmtPeriodo(p.periodoInicio, p.periodoFim) : "não detectado")}
      </div>
      <p class="dex-diag-vazio">Por situação: ${situacoes || "—"}</p>
      <div class="bm-pv-bloco" style="margin-top:10px">
        <b>🔎 Filtragem</b>
        <div class="vd-pv-grid" style="margin-top:8px">
          ${item("Subway Saci (entram na conta)", f.subway ?? "—")}
          ${item("Sem entregador (ignorados)", f.semEntregador ?? 0)}
          ${item("Açaí no Grau (ignorados)", f.acaiNoGrau ?? 0)}
          ${item("Operação indefinida", f.revisaoNecessaria ?? 0)}
        </div>
        ${p.colunaDetalhesEncontrada === false ? `<p class="dex-diag-vazio">⚠️ Não encontrei a coluna "Detalhes do pedido" — não foi possível separar por operação; todos os pedidos serão tratados como Subway Saci.</p>` : ""}
      </div>
      ${!p.periodoDetectado ? `
        <div class="cfg-form-grid" style="margin-top:10px">
          <label class="cfg-campo"><span>Período inicial *</span><input type="date" id="pfd-periodo-ini"></label>
          <label class="cfg-campo"><span>Período final *</span><input type="date" id="pfd-periodo-fim"></label>
        </div>
        <p class="dex-diag-vazio">Não consegui identificar o período automaticamente neste relatório — informe manualmente.</p>` : ""}
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-voltar-1">Trocar arquivo</button>
      <button class="btn btn-primary" id="pfd-ir-etapa2">Continuar →</button>
    </div>`;
  m.querySelector("#pfd-voltar-1").addEventListener("click", () => renderEtapa1(m, ctx));
  m.querySelector("#pfd-ir-etapa2").addEventListener("click", () => {
    if (!p.periodoDetectado) {
      ctx.periodoManual.inicio = m.querySelector("#pfd-periodo-ini")?.value || "";
      ctx.periodoManual.fim = m.querySelector("#pfd-periodo-fim")?.value || "";
      if (!ctx.periodoManual.inicio || !ctx.periodoManual.fim) { toast("Informe o período inicial e final."); return; }
    }
    renderEtapa2(m, ctx);
  });
}

// ---------------------------------------------------------------------------
// ETAPA 2 — códigos "cancelado sem taxa" (item 2 do pedido)
// ---------------------------------------------------------------------------
function renderEtapa2(m, ctx) {
  const corpo = m.querySelector(".pfd-imp-corpo");
  corpo.innerHTML = `
    <p class="dex-diag-vazio">Quais pedidos cancelados <b>não</b> exigem taxa do entregador? Informe o código de cada um — o restante dos pedidos cancelados mantém a taxa normalmente.</p>
    <div class="pfd-cod-form">
      <input type="text" id="pfd-cod-input" placeholder="Ex.: 6222 (ou cole vários separados por vírgula/espaço/linha)">
      <button class="btn btn-ghost btn-sm" id="pfd-cod-add">+ Adicionar pedido</button>
    </div>
    <div class="vd-chips" id="pfd-cod-chips"></div>
    <div id="pfd-conciliacao-2"></div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-voltar-2">← Voltar</button>
      <button class="btn btn-primary" id="pfd-ir-etapa3" disabled>Revisar e confirmar →</button>
    </div>`;

  const input = m.querySelector("#pfd-cod-input");
  const adicionar = () => {
    const novos = [...new Set(input.value.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean))];
    if (!novos.length) return;
    for (const c of novos) if (!ctx.codigos.includes(c)) ctx.codigos.push(c);
    input.value = "";
    recalcularEtapa2(m, ctx);
  };
  m.querySelector("#pfd-cod-add").addEventListener("click", adicionar);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); adicionar(); } });
  m.querySelector("#pfd-voltar-2").addEventListener("click", () => renderPreview1(m, ctx));
  m.querySelector("#pfd-ir-etapa3").addEventListener("click", () => renderEtapa3(m, ctx));

  recalcularEtapa2(m, ctx);
}

async function recalcularEtapa2(m, ctx) {
  renderChips(m, ctx);
  const box = m.querySelector("#pfd-conciliacao-2");
  box.innerHTML = `<div class="estado"><div class="spinner"></div>Recalculando…</div>`;
  try {
    const { data } = await pfdConciliarPreview({
      arquivo: ctx.payloadArquivo, codigosSemTaxa: ctx.codigos,
      periodoInicio: ctx.periodoManual.inicio || undefined, periodoFim: ctx.periodoManual.fim || undefined,
    });
    ctx.conciliacao = data;
    renderValidacaoCodigos(m, ctx);
    box.innerHTML = `
      <div class="vd-pv-grid" style="margin-top:12px">
        <div class="vd-pv-item"><span>Taxas brutas</span><b>${fmtMoeda(data.resumo.taxasBrutas)}</b></div>
        <div class="vd-pv-item"><span>Taxas descartadas</span><b>${fmtMoeda(data.resumo.taxasDescartadas)}</b></div>
        <div class="vd-pv-item"><span>Taxas válidas</span><b>${fmtMoeda(data.resumo.taxasValidas)}</b></div>
      </div>`;
    m.querySelector("#pfd-ir-etapa3").disabled = false;
  } catch (e) {
    box.innerHTML = `<div class="vd-imp-msg erro">Erro ao recalcular: ${escapeHtml(e.message)}</div>`;
  }
}

function renderChips(m, ctx) {
  const box = m.querySelector("#pfd-cod-chips");
  if (!box) return;
  box.innerHTML = ctx.codigos.map((c) => `<button class="vd-chip ativo" data-cod="${escapeHtml(c)}" title="Remover">${escapeHtml(c)} ✕</button>`).join("")
    || `<span class="dex-diag-vazio">Nenhum código informado ainda — todos os cancelados mantêm a taxa.</span>`;
  box.querySelectorAll(".vd-chip").forEach((b) => b.addEventListener("click", () => {
    ctx.codigos = ctx.codigos.filter((c) => c !== b.dataset.cod);
    recalcularEtapa2(m, ctx);
  }));
}

function renderValidacaoCodigos(m, ctx) {
  const box = m.querySelector("#pfd-cod-chips");
  if (!box || !ctx.conciliacao) return;
  const porCodigo = Object.fromEntries((ctx.conciliacao.validacaoCodigos || []).map((v) => [v.codigo, v]));
  box.querySelectorAll(".vd-chip").forEach((b) => {
    const v = porCodigo[b.dataset.cod];
    if (!v) return;
    b.classList.remove("ativo");
    if (!v.encontrado) { b.classList.add("pfd-chip-erro"); b.title = "Pedido não encontrado"; }
    // qualquer alerta (não cancelado, outra operação, sem entregador...) usa o aviso —
    // nunca esconde o motivo atrás do estilo "ok" só porque o pedido está cancelado.
    else if (v.alerta) { b.classList.add("pfd-chip-aviso"); b.title = v.alerta; }
    else { b.classList.add("pfd-chip-ok"); b.title = `Encontrado — ${escapeHtml(v.situacao)}`; }
  });
}

// ---------------------------------------------------------------------------
// ETAPA 3 — revisão final + confirmação
// ---------------------------------------------------------------------------
function renderEtapa3(m, ctx) {
  const corpo = m.querySelector(".pfd-imp-corpo");
  const d = ctx.conciliacao;
  const avisos = [];
  if (d.avisos?.hashDuplicado) avisos.push(`Este arquivo já foi importado (${escapeHtml(d.avisos.hashDuplicado.nomeArquivo || "importação anterior")}) — não será possível confirmar.`);
  for (const s of d.avisos?.periodosSobrepostos || []) avisos.push(`Já existe uma importação cobrindo parte deste período (${fmtPeriodo(s.periodoInicio, s.periodoFim)}, ${escapeHtml(s.nomeArquivo || "arquivo")}).`);

  corpo.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Resumo da conciliação — ${fmtPeriodo(d.periodoInicio, d.periodoFim)}</div>
      <p class="dex-diag-vazio">Filtragem: ${d.filtragem?.subway ?? d.resumo.totalPedidos} Subway com entregador · ${d.filtragem?.semEntregador ?? 0} sem entregador · ${d.filtragem?.acaiNoGrau ?? 0} Açaí no Grau · ${d.filtragem?.revisaoNecessaria ?? 0} indefinidos ignorados. Só quem tem entregador atribuído entra nos valores abaixo.</p>
      <div class="vd-pv-grid">
        <div class="vd-pv-item"><span>Total de pedidos Subway</span><b>${d.resumo.totalPedidos}</b></div>
        <div class="vd-pv-item"><span>Entregues/finalizados</span><b>${d.resumo.entregues}</b></div>
        <div class="vd-pv-item"><span>Cancelados</span><b>${d.resumo.cancelados}</b></div>
        <div class="vd-pv-item"><span>Cancelados com taxa</span><b>${d.resumo.canceladosComTaxa}</b></div>
        <div class="vd-pv-item"><span>Cancelados sem taxa</span><b>${d.resumo.canceladosSemTaxa}</b></div>
        <div class="vd-pv-item"><span>Taxas válidas</span><b>${fmtMoeda(d.resumo.taxasValidas)}</b></div>
      </div>
      ${avisos.length ? `<div class="vd-pv-divs">${avisos.map((a) => `<div class="vd-pv-div"><span class="pill warn">atenção</span> ${a}</div>`).join("")}</div>` : `<div class="vd-pv-ok">✅ Nenhuma duplicidade encontrada para este período.</div>`}
    </div>
    <div class="vd-imp-msg" id="pfd-imp-msg-3" hidden></div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-voltar-3">← Voltar</button>
      <button class="btn btn-primary" id="pfd-confirmar" ${d.avisos?.hashDuplicado ? "disabled" : ""}>Confirmar importação</button>
    </div>`;

  m.querySelector("#pfd-voltar-3").addEventListener("click", () => renderEtapa2(m, ctx));
  m.querySelector("#pfd-confirmar").addEventListener("click", () => confirmar(m, ctx));
}

async function confirmar(m, ctx) {
  const msg = m.querySelector("#pfd-imp-msg-3");
  const btn = m.querySelector("#pfd-confirmar");
  const txtOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = "Salvando…";
  try {
    const { data } = await pfdConciliarConfirmar({
      arquivo: ctx.payloadArquivo, codigosSemTaxa: ctx.codigos,
      periodoInicio: ctx.periodoManual.inicio || undefined, periodoFim: ctx.periodoManual.fim || undefined,
    });
    toast("Relatório importado e conciliado ✅");
    fecharOverlay();
    ctx.onSalvo?.(data);
  } catch (e) {
    msg.hidden = false; msg.className = "vd-imp-msg erro"; msg.textContent = "Erro: " + e.message;
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}
