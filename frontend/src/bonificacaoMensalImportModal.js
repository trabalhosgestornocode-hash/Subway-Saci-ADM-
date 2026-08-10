// Modal "Importar Visio" — 2 relatórios (Geral + Loja) da Visio Analytics.
// A leitura/interpretação do PDF acontece sempre no BACKEND
// (bonificacao-mensal/visio-parser.js); o frontend só embala o arquivo em
// base64, mostra a prévia e deixa corrigir manualmente antes de confirmar.
import { el, escapeHtml, toast, fmtMoeda, fmtPct } from "./utils.js";
import { bonifImportarPreview, bonifImportarConfirmar } from "./api.js";

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

// ---------- arquivo -> base64 (mesma técnica de vendas.js) ----------
async function arquivoPayload(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCO));
  return { nomeArquivo: file.name, conteudoBase64: btoa(bin) };
}

const dropZoneHtml = (id, titulo, descricao) => `
  <div class="bm-drop" id="${id}-drop">
    <div class="bm-drop-titulo">${escapeHtml(titulo)}</div>
    <p class="bm-drop-desc">${escapeHtml(descricao)}</p>
    <div class="bm-drop-area" tabindex="0" role="button">
      <span class="bm-drop-icone">📄</span>
      <span class="bm-drop-txt">Arraste o PDF aqui ou <u>selecione o arquivo</u></span>
      <em id="${id}-nome">Nenhum arquivo selecionado</em>
    </div>
    <input type="file" id="${id}-input" accept=".pdf" hidden>
  </div>`;

function wireDropZone(m, id, onArquivo) {
  const zona = m.querySelector(`#${id}-drop`);
  const area = zona.querySelector(".bm-drop-area");
  const input = zona.querySelector(`#${id}-input`);
  const nomeEl = zona.querySelector(`#${id}-nome`);
  const aplicar = (file) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { toast("Selecione um arquivo PDF."); return; }
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

export function abrirImportarVisioModal({ unidadeNome, mesAtual, anoAtual, onSalvo }) {
  // `ctx` é o estado do modal, compartilhado por todos os handlers — nunca
  // recriado por chamada, pra "prévia" e "correções" ficarem sempre em sincronia.
  const ctx = { arquivos: { geral: null, loja: null }, ultimoPreview: null, onSalvo };
  const hojeIso = new Date().toISOString().slice(0, 10);

  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>⬆️ Importar dados da Visio</h2><div class="modal-tags"><span class="chip">🏪 ${escapeHtml(unidadeNome || "—")}</span></div></div>
    <div class="bm-imp-form">
      <label class="cfg-campo bm-imp-data"><span>Data do lançamento *</span><input type="date" id="bm-imp-data" value="${hojeIso}"></label>
      ${dropZoneHtml("bm-geral", "Relatório Geral", "Relatório com todos os canais. Utilizado principalmente para o faturamento total da loja.")}
      ${dropZoneHtml("bm-loja", "Relatório Loja", "Relatório filtrado somente para Loja/Balcão. Utilizado para calcular as metas de Bebidas, Adicionais e Diversos.")}
      <div class="vd-imp-msg" id="bm-imp-msg" hidden></div>
      <div id="bm-imp-preview"></div>
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="bm-imp-cancelar">Cancelar</button>
      <button class="btn btn-ghost" id="bm-imp-analisar">Analisar relatórios</button>
      <button class="btn btn-primary" id="bm-imp-confirmar" disabled>Confirmar lançamento</button>
    </div>`);

  ctx.hojeIso = () => m.querySelector("#bm-imp-data").value;

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#bm-imp-cancelar").addEventListener("click", fecharOverlay);
  wireDropZone(m, "bm-geral", (f) => { ctx.arquivos.geral = f; invalidar(); });
  wireDropZone(m, "bm-loja", (f) => { ctx.arquivos.loja = f; invalidar(); });
  m.querySelector("#bm-imp-data").addEventListener("change", invalidar);
  m.querySelector("#bm-imp-analisar").addEventListener("click", () => processar(m, ctx, false));
  m.querySelector("#bm-imp-confirmar").addEventListener("click", () => processar(m, ctx, true));

  function invalidar() {
    ctx.ultimoPreview = null;
    m.querySelector("#bm-imp-confirmar").disabled = true;
    m.querySelector("#bm-imp-preview").innerHTML = "";
    m.querySelector("#bm-imp-msg").hidden = true;
  }
}

async function processar(m, ctx, confirmar) {
  const msg = m.querySelector("#bm-imp-msg");
  const setMsg = (t, cls = "erro") => { msg.hidden = false; msg.className = "vd-imp-msg " + cls; msg.textContent = t; };
  const dataLancamento = ctx.hojeIso();
  if (!dataLancamento) return setMsg("Informe a data do lançamento.");
  if (!ctx.arquivos.geral && !ctx.arquivos.loja) return setMsg("Envie pelo menos um dos dois relatórios (Geral ou Loja).");

  const btn = m.querySelector(confirmar ? "#bm-imp-confirmar" : "#bm-imp-analisar");
  const txtOriginal = btn.textContent;
  const etapas = confirmar ? ["Salvando…"] : ["Enviando arquivos…", "Lendo relatórios…", "Validando informações…"];
  let i = 0;
  btn.disabled = true;
  const timer = etapas.length > 1 ? setInterval(() => { btn.textContent = etapas[Math.min(i++, etapas.length - 1)]; }, 700) : null;
  btn.textContent = etapas[0];

  try {
    let payload = ctx.ultimoPreview?.payload;
    if (!confirmar || !payload) {
      const [geral, loja] = await Promise.all([arquivoPayload(ctx.arquivos.geral), arquivoPayload(ctx.arquivos.loja)]);
      payload = { data: dataLancamento, geral, loja };
      ctx.ultimoPreview = { payload };
    }
    if (confirmar) {
      await bonifImportarConfirmar({ ...payload, substituir: ctx.ultimoPreview?.substituir });
      toast("Relatórios processados. Lançamento salvo ✅");
      fecharOverlay();
      ctx.onSalvo?.();
    } else {
      const { data } = await bonifImportarPreview(payload);
      if (data.duplicado) return renderDuplicado(m, ctx, data);
      renderPreview(m, ctx, data);
    }
  } catch (e) {
    setMsg("Erro: " + e.message);
  } finally {
    if (timer) clearInterval(timer);
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}

function renderDuplicado(m, ctx, data) {
  const box = m.querySelector("#bm-imp-preview");
  const l = data.existente;
  const p = data.preview;
  const linha = (lbl, atual, novo) => `<tr><td>${lbl}</td><td class="num">${atual}</td><td class="num">${novo}</td></tr>`;
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">⚠️ Já existe um lançamento para ${fmtDataBr(p.data)}</div>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th></th><th class="num">Valor atual</th><th class="num">Novo valor</th></tr></thead>
        <tbody>
          ${linha("Faturamento Geral", fmtMoeda(l.faturamentoGeral), p.geral ? fmtMoeda(p.geral.faturamento) : "—")}
          ${linha("PPD Geral", l.ppdGeral ?? "—", p.geral?.ppd ?? "—")}
          ${linha("Faturamento Loja", fmtMoeda(l.faturamentoLoja), p.loja ? fmtMoeda(p.loja.faturamento) : "—")}
          ${linha("Sanduíches/Saladas", l.qtdSanduichesLoja ?? "—", p.loja?.sanduichesSaladas ?? "—")}
          ${linha("Bebidas", l.qtdBebidasLoja ?? "—", p.loja?.bebidas ?? "—")}
          ${linha("Adicionais", l.qtdAdicionaisLoja ?? "—", p.loja?.adicionais ?? "—")}
          ${linha("Diversos", l.qtdDiversosLoja ?? "—", p.loja?.diversos ?? "—")}
          ${linha("Origem", escapeHtml(l.origem), "visio")}
        </tbody>
      </table></div>
      <p class="dex-diag-vazio">Confirmar vai <b>substituir</b> este lançamento pelos novos valores acima.</p>
    </div>`;
  const conf = m.querySelector("#bm-imp-confirmar");
  conf.disabled = false; conf.textContent = "Substituir lançamento";
  ctx.ultimoPreview.substituir = true;
}

function renderPreview(m, ctx, data) {
  const p = data.preview;
  const box = m.querySelector("#bm-imp-preview");
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Dados encontrados — ${fmtDataBr(p.data)}</div>
      ${p.geral ? `<div class="bm-pv-bloco"><b>Geral</b><div class="vd-pv-grid">
        ${item("Faturamento Total", fmtMoeda(p.geral.faturamento))}
        ${item("PPD", p.geral.ppd)}
        ${item("Estabelecimento", escapeHtml(p.geral.estabelecimento || "—"))}
      </div></div>` : `<p class="dex-diag-vazio">Relatório Geral não enviado.</p>`}
      ${p.loja ? `<div class="bm-pv-bloco"><b>Loja / Balcão</b><div class="vd-pv-grid">
        ${item("Faturamento Loja", fmtMoeda(p.loja.faturamento))}
        ${item("PPD", p.loja.ppd)}
        ${item("Sanduíches/Saladas", p.loja.sanduichesSaladas)}
        ${item("Bebidas", `${p.loja.bebidas} → ${fmtPct(p.loja.mixCalculado?.bebidas)}`)}
        ${item("Adicionais", `${p.loja.adicionais} → ${fmtPct(p.loja.mixCalculado?.adicionais)}`)}
        ${item("Diversos", `${p.loja.diversos} → ${fmtPct(p.loja.mixCalculado?.diversos)}`)}
        ${item("Estabelecimento", escapeHtml(p.loja.estabelecimento || "—"))}
      </div></div>` : `<p class="dex-diag-vazio">Relatório Loja não enviado.</p>`}
      ${p.avisos?.length ? `<div class="vd-pv-divs">${p.avisos.map((a) => `<div class="vd-pv-div"><span class="pill warn">atenção</span> ${escapeHtml(a)}</div>`).join("")}</div>` : `<div class="vd-pv-ok">✅ Nenhuma divergência encontrada.</div>`}
      <details class="bm-pv-corrigir"><summary>Algum número foi lido errado? Corrigir manualmente</summary>
        <div class="cfg-form-grid">
          ${p.geral ? `<label class="cfg-campo"><span>Faturamento Geral (correção)</span><input type="number" step="0.01" id="bm-corr-geral-faturamento" placeholder="${p.geral.faturamento}"></label>
          <label class="cfg-campo"><span>PPD Geral (correção)</span><input type="number" step="1" id="bm-corr-geral-ppd" placeholder="${p.geral.ppd}"></label>` : ""}
          ${p.loja ? `<label class="cfg-campo"><span>Faturamento Loja (correção)</span><input type="number" step="0.01" id="bm-corr-loja-faturamento" placeholder="${p.loja.faturamento}"></label>
          <label class="cfg-campo"><span>Sanduíches/Saladas (correção)</span><input type="number" step="1" id="bm-corr-loja-sandwichesSalads" placeholder="${p.loja.sanduichesSaladas}"></label>
          <label class="cfg-campo"><span>Bebidas (correção)</span><input type="number" step="1" id="bm-corr-loja-beverages" placeholder="${p.loja.bebidas}"></label>
          <label class="cfg-campo"><span>Adicionais (correção)</span><input type="number" step="1" id="bm-corr-loja-additions" placeholder="${p.loja.adicionais}"></label>
          <label class="cfg-campo"><span>Diversos (correção)</span><input type="number" step="1" id="bm-corr-loja-miscellaneous" placeholder="${p.loja.diversos}"></label>` : ""}
        </div>
        <p class="dex-diag-vazio">Campos preenchidos aqui substituem o valor lido do PDF e ficam marcados como correção manual.</p>
        <button class="btn btn-ghost btn-sm" id="bm-corr-aplicar" type="button">Reanalisar com as correções</button>
      </details>
    </div>`;

  const conf = m.querySelector("#bm-imp-confirmar");
  conf.disabled = false; conf.textContent = "Confirmar lançamento";
  m.querySelector("#bm-corr-aplicar")?.addEventListener("click", () => aplicarCorrecoes(m, ctx));
}

function aplicarCorrecoes(m, ctx) {
  const lerNum = (id) => { const v = m.querySelector(`#${id}`)?.value; return v === "" || v == null ? undefined : v; };
  const correcoes = {
    geral: { faturamento: lerNum("bm-corr-geral-faturamento"), ppd: lerNum("bm-corr-geral-ppd") },
    loja: {
      faturamento: lerNum("bm-corr-loja-faturamento"), sandwichesSalads: lerNum("bm-corr-loja-sandwichesSalads"),
      beverages: lerNum("bm-corr-loja-beverages"), additions: lerNum("bm-corr-loja-additions"), miscellaneous: lerNum("bm-corr-loja-miscellaneous"),
    },
  };
  if (ctx.ultimoPreview?.payload) ctx.ultimoPreview.payload = { ...ctx.ultimoPreview.payload, correcoes };
  m.querySelector("#bm-imp-analisar").click();
}

const fmtDataBr = (iso) => iso?.split("-").reverse().join("/") ?? "—";
