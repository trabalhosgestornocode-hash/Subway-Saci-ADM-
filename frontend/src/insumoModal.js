// Modal de INSUMO: cadastro, edição (com prévia de custo em tempo real),
// histórico de preço e lista de produtos que utilizam o insumo.
import { obterInsumo, criarInsumo, atualizarInsumo } from "./api.js";
import { CATEGORIAS_INSUMO, CATEGORIA_INSUMO_ROTULO, UNIDADES_BASE, UNIDADE_ROTULO, FORMAS_COMPRA } from "./config.js";
import { fmtMoeda, fmtPct, fmtTexto, fmtDataHora, escapeHtml, toast } from "./utils.js";
import { icon } from "./icons.js";

let overlay = null;
function fechar() { overlay?.remove(); overlay = null; document.removeEventListener("keydown", onKey); }
function onKey(e) { if (e.key === "Escape") fechar(); }

const catLabel = (c) => CATEGORIA_INSUMO_ROTULO[c] ?? fmtTexto(c);

// Prévia do custo por unidade-base (mesma fórmula do backend: preço ÷ conteúdo).
function previaCusto(preco, rendimento) {
  const p = Number(preco), q = Number(rendimento);
  if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0 || preco === "" || rendimento === "") return null;
  return p / q;
}

/**
 * @param {string|null} id  null = novo insumo
 * @param {{editar?: boolean, onSalvar?: Function}} [opts]
 */
export async function abrirInsumoModal(id, opts = {}) {
  fechar();
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal"><div class="estado"><div class="spinner"></div>Carregando…</div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  try {
    if (!id) return renderForm(null, { ...opts, editar: true });
    const { data } = await obterInsumo(id);
    if (opts.editar) renderForm(data, opts);
    else renderDetalhe(data, opts);
  } catch (e) {
    overlay.querySelector(".modal").innerHTML =
      `<button class="modal-close" aria-label="Fechar">×</button><div class="estado erro"><span class="estado-ic">${icon("alert-triangle", { size: 22 })}</span><h3>Erro</h3><p>${escapeHtml(e.message)}</p></div>`;
    overlay.querySelector(".modal-close").addEventListener("click", fechar);
  }
}

// ---------------------------------------------------------------------------
// FORMULÁRIO (novo / edição)
// ---------------------------------------------------------------------------
function renderForm(insumo, opts) {
  const novo = !insumo;
  const val = (k, d = "") => (insumo && insumo[k] != null ? insumo[k] : d);
  const catSel = novo ? "outro" : val("categoria", "outro");
  const uniSel = novo ? "un" : val("unidade_base", "un");

  overlay.querySelector(".modal").innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${novo ? `${icon("plus", { size: 17 })} Novo insumo` : `${icon("pencil", { size: 17 })} Editar insumo`}</h2></div>

    <div class="modal-sec-titulo">${icon("id-card", { size: 14 })} Identificação</div>
    <div class="ed-grid">
      <label class="ed-campo"><span>Nome *</span>
        <input id="in-nome" type="text" value="${escapeHtml(val("nome"))}" maxlength="160" /></label>
      <label class="ed-campo"><span>Código interno</span>
        <input id="in-codigo" type="text" value="${escapeHtml(val("codigo"))}" maxlength="60" placeholder="opcional" /></label>
      <label class="ed-campo"><span>Categoria</span>
        <select id="in-categoria">${CATEGORIAS_INSUMO.map(([v, l]) => `<option value="${v}" ${v === catSel ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="ed-campo ed-check"><input id="in-ativo" type="checkbox" ${insumo && !insumo.ativo ? "" : "checked"} /><span>Insumo ativo</span></label>
      <label class="ed-campo ed-campo-full"><span>Descrição</span>
        <input id="in-descricao" type="text" value="${escapeHtml(val("descricao"))}" maxlength="500" placeholder="opcional" /></label>
    </div>

    <div class="modal-sec-titulo">${icon("shopping-cart", { size: 14 })} Informações de compra</div>
    <div class="ed-grid">
      <label class="ed-campo"><span>Forma de compra</span>
        <input id="in-forma" type="text" list="in-formas" value="${escapeHtml(val("forma_compra"))}" placeholder="caixa, pacote..." />
        <datalist id="in-formas">${FORMAS_COMPRA.map((f) => `<option value="${f}">`).join("")}</datalist></label>
      <label class="ed-campo"><span>Preço da embalagem (R$)</span>
        <input id="in-preco" type="number" min="0" step="0.01" value="${val("preco_caixa", "")}" placeholder="ex: 47,52" /></label>
      <label class="ed-campo"><span>Quantidade contida</span>
        <input id="in-rendimento" type="number" min="0" step="0.001" value="${val("rendimento", "")}" placeholder="ex: 24" /></label>
      <label class="ed-campo"><span>Unidade-base</span>
        <select id="in-unidade">${UNIDADES_BASE.map(([v, l]) => `<option value="${v}" ${v === uniSel ? "selected" : ""}>${l} (${v})</option>`).join("")}</select></label>
      <label class="ed-campo"><span>Data do preço</span>
        <input id="in-data" type="date" value="${insumo?.preco_atualizado_em ? String(insumo.preco_atualizado_em).slice(0, 10) : ""}" /></label>
      ${novo ? "" : `<label class="ed-campo ed-campo-full"><span>Observação da alteração</span>
        <input id="in-obs" type="text" maxlength="300" placeholder="motivo do reajuste (vai para o histórico)" /></label>`}
    </div>

    <div class="modal-custo" id="in-previa"><span>Custo por unidade-base</span><strong>—</strong></div>

    <div class="ed-erro" id="in-erro" hidden></div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="in-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="in-salvar">${novo ? "Cadastrar insumo" : "Salvar alterações"}</button>
    </div>
  `;

  const m = overlay.querySelector(".modal");
  const atualizarPrevia = () => {
    const c = previaCusto(m.querySelector("#in-preco").value, m.querySelector("#in-rendimento").value);
    const un = m.querySelector("#in-unidade").value;
    m.querySelector("#in-previa strong").textContent = c == null ? "—" : `${fmtMoeda(c)} / ${un}`;
  };
  ["#in-preco", "#in-rendimento", "#in-unidade"].forEach((s) => m.querySelector(s).addEventListener("input", atualizarPrevia));
  atualizarPrevia();

  m.querySelector(".modal-close").addEventListener("click", fechar);
  m.querySelector("#in-cancelar").addEventListener("click", fechar);
  m.querySelector("#in-salvar").addEventListener("click", () => salvar(insumo?.id, m, opts));
}

async function salvar(id, m, opts) {
  const erroBox = m.querySelector("#in-erro");
  const btn = m.querySelector("#in-salvar");
  const nome = m.querySelector("#in-nome").value.trim();
  if (!nome) { erroBox.textContent = "Informe o nome do insumo."; erroBox.hidden = false; return; }

  const dados = {
    nome,
    codigo: m.querySelector("#in-codigo").value.trim() || null,
    tipo: m.querySelector("#in-categoria").value,
    descricao: m.querySelector("#in-descricao").value.trim() || null,
    forma_compra: m.querySelector("#in-forma").value.trim() || null,
    ativo: m.querySelector("#in-ativo").checked,
    preco_caixa: m.querySelector("#in-preco").value,
    rendimento: m.querySelector("#in-rendimento").value,
    unidade_medida: m.querySelector("#in-unidade").value,
    preco_atualizado_em: m.querySelector("#in-data").value || undefined,
  };
  const obs = m.querySelector("#in-obs");
  if (obs) dados.observacao = obs.value.trim() || undefined;

  btn.disabled = true; btn.textContent = "Salvando…"; erroBox.hidden = true;
  try {
    if (id) {
      const { data } = await atualizarInsumo(id, dados);
      toast(data.custo_mudou && data.recalculados > 0
        ? `Preço atualizado. ${data.recalculados} produto(s) recalculado(s).`
        : `"${nome}" atualizado.`);
    } else {
      await criarInsumo(dados);
      toast(`"${nome}" cadastrado.`);
    }
    fechar();
    opts.onSalvar?.();
  } catch (e) {
    erroBox.textContent = "Erro ao salvar: " + e.message;
    erroBox.hidden = false;
    btn.disabled = false;
    btn.textContent = id ? "Salvar alterações" : "Cadastrar insumo";
  }
}

// ---------------------------------------------------------------------------
// DETALHE (visão geral + histórico + produtos que usam)
// ---------------------------------------------------------------------------
function renderDetalhe(i, opts) {
  const podeEditar = opts.podeEditar ?? true;
  const custo = i.custo_unitario == null
    ? '<span class="pill muted">sem custo</span>'
    : `${fmtMoeda(i.custo_unitario)} <small>/ ${i.unidade_base}</small>`;

  const histRows = (i.historico ?? []).length
    ? i.historico.map((h) => `
        <tr>
          <td>${fmtDataHora(h.created_at)}</td>
          <td class="num">${fmtMoeda(h.preco_anterior)} → <b>${fmtMoeda(h.preco_novo)}</b></td>
          <td class="num">${fmtMoeda(h.custo_anterior)} → <b>${fmtMoeda(h.custo_novo)}</b></td>
          <td class="num">${h.variacao_pct == null ? "—" : (Number(h.variacao_pct) > 0 ? "+" : "") + fmtPct(h.variacao_pct)}</td>
          <td>${escapeHtml(h.usuario_nome || h.usuario_email || "—")}${h.observacao ? `<small class="cu-cod">${escapeHtml(h.observacao)}</small>` : ""}</td>
        </tr>`).join("")
    : `<tr><td colspan="5"><div class="estado"><p>${i.historico_pendente ? "O histórico será registrado após aplicar a migration 021." : "Sem alterações de preço registradas."}</p></div></td></tr>`;

  const prodRows = (i.produtos ?? []).length
    ? i.produtos.map((p) => `<tr><td>${escapeHtml(p.nome)}</td><td class="num">${fmtMoeda(p.custo_atual)}</td></tr>`).join("")
    : `<tr><td colspan="2"><div class="estado"><p>Nenhum produto usa este insumo ainda.</p></div></td></tr>`;

  overlay.querySelector(".modal").innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>${escapeHtml(i.nome)}</h2>
      <div class="modal-tags">
        <span class="chip">${catLabel(i.categoria)}</span>
        ${i.codigo ? `<span class="chip">${escapeHtml(i.codigo)}</span>` : ""}
        ${i.ativo ? '<span class="pill ok">Ativo</span>' : '<span class="pill muted">Inativo</span>'}
      </div>
    </div>
    <div class="modal-custo"><span>Custo por unidade-base</span><strong>${custo}</strong></div>

    <div class="modal-sec-titulo">${icon("shopping-cart", { size: 14 })} Compra</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal"><tbody>
        <tr><td>Forma de compra</td><td class="num">${fmtTexto(i.forma_compra)}</td></tr>
        <tr><td>Preço da embalagem</td><td class="num">${fmtMoeda(i.preco_caixa)}</td></tr>
        <tr><td>Quantidade contida</td><td class="num">${i.rendimento != null ? `${i.rendimento.toLocaleString("pt-BR")} ${i.unidade_base}` : "—"}</td></tr>
        <tr><td>Última atualização</td><td class="num">${i.preco_atualizado_em ? fmtDataHora(i.preco_atualizado_em) : "—"}</td></tr>
      </tbody></table>
    </div>

    <div class="modal-sec-titulo">${icon("trending-up", { size: 14 })} Histórico de preço</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Quando</th><th class="num">Preço</th><th class="num">Custo un.</th><th class="num">Variação</th><th>Por</th></tr></thead>
        <tbody>${histRows}</tbody>
      </table>
    </div>

    <div class="modal-sec-titulo">${icon("grid", { size: 14 })} Produtos que usam (${(i.produtos ?? []).length})</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Produto</th><th class="num">Custo atual</th></tr></thead>
        <tbody>${prodRows}</tbody>
      </table>
    </div>

    <div class="ed-acoes">
      <button class="btn btn-ghost" id="in-fechar">Fechar</button>
      ${podeEditar ? `<button class="btn btn-primary" id="in-editar">${icon("pencil", { size: 13 })} Editar / Atualizar preço</button>` : ""}
    </div>
  `;

  const m = overlay.querySelector(".modal");
  m.querySelector(".modal-close").addEventListener("click", fechar);
  m.querySelector("#in-fechar").addEventListener("click", fechar);
  m.querySelector("#in-editar")?.addEventListener("click", () => renderForm(i, opts));
}
