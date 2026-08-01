// Aba INSUMOS — listagem, indicadores, filtros e ações.
// Reutiliza os componentes visuais do sistema (toolbar, cards, grid, pills).
import { state } from "./state.js";
import { el, els, fmtMoeda, fmtTexto, fmtDataHora, escapeHtml, toast } from "./utils.js";
import { CATEGORIAS_INSUMO, CATEGORIA_INSUMO_ROTULO } from "./config.js";
import { listarInsumos, definirStatusInsumo, excluirInsumo } from "./api.js";
import { abrirInsumoModal } from "./insumoModal.js";

// Filtros locais desta aba (não poluem o estado global de CMV).
const filtros = { busca: "", categoria: "todos", status: "todos", semPreco: false };

const podeEditar = () => (state.sessao?.permissoes ?? []).includes("insumos.editar");
const catLabel = (c) => CATEGORIA_INSUMO_ROTULO[c] ?? fmtTexto(c);
const custoLabel = (i) =>
  i.custo_unitario == null ? '<span class="pill muted">sem custo</span>'
    : `${fmtMoeda(i.custo_unitario)}<small class="cu-un">/${escapeHtml(i.unidade_base)}</small>`;

const card = (label, valor, classe = "", sub = "") =>
  `<div class="card ${classe}"><div class="card-label">${label}</div><div class="card-valor">${valor}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;

export async function renderInsumos() {
  const editar = podeEditar();
  el("#view").innerHTML = `
    <div class="cards" id="ins-stats">
      ${card("Insumos ativos", "…")}
      ${card("Sem custo", "…")}
      ${card("Inativos", "…")}
      ${card("Atualizados (7 dias)", "…")}
    </div>

    <div class="toolbar">
      <div class="busca"><input id="ins-busca" type="search" placeholder="Buscar por nome ou código..." value="${escapeHtml(filtros.busca)}" aria-label="Buscar insumo" /></div>
      <select id="ins-categoria" aria-label="Filtrar por categoria">
        <option value="todos">Todas as categorias</option>
        ${CATEGORIAS_INSUMO.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
      </select>
      <select id="ins-status" aria-label="Filtrar por status">
        <option value="todos">Todos os status</option>
        <option value="ativo">🟢 Ativos</option>
        <option value="inativo">⚪ Inativos</option>
      </select>
      <label class="ins-check"><input type="checkbox" id="ins-sempreco" ${filtros.semPreco ? "checked" : ""} /> Sem preço</label>
      <button id="ins-atualizar" class="btn btn-ghost btn-sm">🔄 Atualizar</button>
      ${editar ? `<button id="ins-novo" class="btn btn-primary btn-sm">➕ Adicionar insumo</button>` : ""}
      <span class="result-count" id="ins-count"></span>
    </div>

    <div class="tabela-wrap">
      <table class="grid">
        <thead><tr>
          <th>Insumo</th><th>Categoria</th><th>Forma de compra</th>
          <th class="num">Embalagem</th><th class="num">Preço</th><th class="num">Custo / un-base</th>
          <th>Atualizado</th><th>Status</th><th>Ações</th>
        </tr></thead>
        <tbody id="ins-tbody"><tr><td colspan="9"><div class="estado"><div class="spinner"></div>Carregando insumos…</div></td></tr></tbody>
      </table>
    </div>
    <p class="rodape">Custo por unidade-base = preço da embalagem ÷ quantidade contida. As fichas técnicas usam este custo automaticamente.</p>
  `;

  el("#ins-categoria").value = filtros.categoria;
  el("#ins-status").value = filtros.status;

  el("#ins-busca").addEventListener("input", (e) => { filtros.busca = e.target.value; carregar(); });
  el("#ins-categoria").addEventListener("change", (e) => { filtros.categoria = e.target.value; carregar(); });
  el("#ins-status").addEventListener("change", (e) => { filtros.status = e.target.value; carregar(); });
  el("#ins-sempreco").addEventListener("change", (e) => { filtros.semPreco = e.target.checked; carregar(); });
  el("#ins-atualizar").addEventListener("click", carregar);
  el("#ins-novo")?.addEventListener("click", () => abrirInsumoModal(null, { onSalvar: carregar }));

  carregar();
}

let _itens = [];

async function carregar() {
  const tb = el("#ins-tbody");
  if (!tb) return;
  try {
    const { data } = await listarInsumos({
      busca: filtros.busca || undefined,
      categoria: filtros.categoria === "todos" ? undefined : filtros.categoria,
      status: filtros.status === "todos" ? undefined : filtros.status,
      sem_preco: filtros.semPreco ? "true" : undefined,
    });
    if (el("#ins-tbody") !== tb) return; // view trocou
    _itens = data.itens ?? [];
    pintarStats(data.stats ?? {});
    pintarTabela();
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="9"><div class="estado erro"><span class="emoji">⚠️</span><h3>Falha ao carregar</h3><p>${escapeHtml(e.message)}</p></div></td></tr>`;
  }
}

function pintarStats(s) {
  const box = el("#ins-stats");
  if (!box) return;
  box.innerHTML = [
    card("Insumos ativos", s.ativos ?? 0),
    card("Sem custo", s.sem_custo ?? 0, (s.sem_custo ?? 0) > 0 ? "alerta" : ""),
    card("Inativos", s.inativos ?? 0),
    card("Atualizados (7 dias)", s.atualizados_recentes ?? 0),
  ].join("");
}

function pintarTabela() {
  const tb = el("#ins-tbody");
  const rc = el("#ins-count");
  if (rc) rc.textContent = `${_itens.length} insumo(s)`;
  if (!_itens.length) {
    tb.innerHTML = `<tr><td colspan="9"><div class="estado"><span class="emoji">📭</span><h3>Nenhum insumo</h3><p>Ajuste os filtros ou cadastre o primeiro insumo.</p></div></td></tr>`;
    return;
  }
  const editar = podeEditar();
  tb.innerHTML = _itens.map((i, idx) => {
    const emb = i.rendimento != null ? `${i.rendimento.toLocaleString("pt-BR")} ${i.unidade_base}` : "—";
    const acoes = [
      `<button class="acao-btn" data-acao="ver" data-idx="${idx}" title="Ver detalhes" aria-label="Ver detalhes">👁️</button>`,
      editar ? `<button class="acao-btn" data-acao="editar" data-idx="${idx}" title="Editar" aria-label="Editar">✏️</button>` : "",
      editar ? (i.ativo
        ? `<button class="acao-btn" data-acao="inativar" data-idx="${idx}" title="Inativar" aria-label="Inativar">🚫</button>`
        : `<button class="acao-btn" data-acao="reativar" data-idx="${idx}" title="Reativar" aria-label="Reativar">↩️</button>`) : "",
      editar ? `<button class="acao-btn acao-perigo" data-acao="remover" data-idx="${idx}" title="Remover insumo" aria-label="Remover insumo">🗑️</button>` : "",
    ].join("");
    return `<tr class="${i.ativo ? "" : "linha-inativa"}">
      <td class="prod-nome"><button class="prod-link" data-acao="ver" data-idx="${idx}">${escapeHtml(i.nome)}</button>${i.codigo ? `<small class="cu-cod">${escapeHtml(i.codigo)}</small>` : ""}</td>
      <td>${catLabel(i.categoria)}</td>
      <td>${fmtTexto(i.forma_compra)}</td>
      <td class="num">${emb}</td>
      <td class="num">${fmtMoeda(i.preco_caixa)}</td>
      <td class="num">${custoLabel(i)}</td>
      <td>${i.preco_atualizado_em ? fmtDataHora(i.preco_atualizado_em) : "—"}</td>
      <td>${i.ativo ? '<span class="pill ok">Ativo</span>' : '<span class="pill muted">Inativo</span>'}</td>
      <td><div class="acoes">${acoes}</div></td>
    </tr>`;
  }).join("");

  tb.querySelectorAll("[data-acao]").forEach((btn) =>
    btn.addEventListener("click", () => acao(btn.dataset.acao, _itens[Number(btn.dataset.idx)])));
}

async function acao(nome, insumo) {
  if (!insumo) return;
  if (nome === "ver") return abrirInsumoModal(insumo.id, { onSalvar: carregar });
  if (nome === "editar") return abrirInsumoModal(insumo.id, { editar: true, onSalvar: carregar });

  if (nome === "inativar") {
    if (!confirm(`Inativar "${insumo.nome}"? Ele deixará de aparecer para novas fichas, mas o histórico é preservado.`)) return;
    try {
      const { data } = await definirStatusInsumo(insumo.id, false);
      const n = data.produtos_afetados;
      toast(n > 0
        ? `"${insumo.nome}" inativado. ${n} produto(s) usam este insumo — revise as fichas.`
        : `"${insumo.nome}" inativado.`);
      carregar();
    } catch (e) { toast("Erro: " + e.message); }
    return;
  }
  if (nome === "reativar") {
    try {
      await definirStatusInsumo(insumo.id, true);
      toast(`"${insumo.nome}" reativado.`);
      carregar();
    } catch (e) { toast("Erro: " + e.message); }
    return;
  }

  if (nome === "remover") {
    if (!confirm(`Excluir o insumo "${insumo.nome}"?\n\nO histórico de preço dele será removido junto. Esta ação não pode ser desfeita.`)) return;
    try {
      await excluirInsumo(insumo.id);
      toast(`"${insumo.nome}" foi excluído.`);
      carregar();
    } catch (e) {
      const msg = e.message || "Não foi possível excluir.";
      // O servidor recusa (409) quando o insumo está em alguma ficha técnica ou
      // tem movimentação/compra. Nesses casos, inativar é a alternativa segura.
      if (/não pode ser excluído/i.test(msg) && /inative/i.test(msg)) {
        if (insumo.ativo && confirm(`${msg}\n\nDeseja INATIVAR "${insumo.nome}" agora?`)) {
          try {
            await definirStatusInsumo(insumo.id, false);
            toast(`"${insumo.nome}" foi inativado.`);
            carregar();
          } catch (e2) { alert("Erro ao inativar: " + e2.message); }
        } else if (!insumo.ativo) alert(msg);
        return;
      }
      alert(msg);
    }
  }
}
