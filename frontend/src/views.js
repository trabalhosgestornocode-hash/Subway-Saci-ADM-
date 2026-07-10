import { state, linhasFiltradas } from "./state.js";
import { INTEGRACOES, STATUS_INTEGRACAO } from "./config.js";
import { ACOES_TABELA } from "./actions.js";
import { el, fmtMoeda, fmtPct, fmtTexto, fmtHora, fmtRelativo, escapeHtml, temValor, statusCmv } from "./utils.js";
import { renderGraficos } from "./charts.js";
import { obterHistoricoRecente } from "./api.js";
import { abrirHistoricoModal, fmtValor } from "./historicoModal.js";

// ---------- rótulos ----------
const CAT_LABEL = {
  sanduiche: "Sanduíche", salada: "Salada", bebida: "Bebida", sobremesa: "Sobremesa",
  chips: "Chips", adicional: "Adicional", acompanhamento: "Acompanhamento",
  combo: "Combo", submontagem: "Submontagem", outro: "Outro",
};
const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const catLabel = (t) => (temValor(t) ? (CAT_LABEL[t] || t[0].toUpperCase() + t.slice(1)) : "—");
const canalLabel = (c) => CANAL_LABEL[c] || fmtTexto(c);

// ---------- componentes reutilizáveis ----------
const card = (label, valor, classe = "", sub = "") =>
  `<div class="card ${classe}"><div class="card-label">${label}</div><div class="card-valor">${valor}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;

const cardDestaque = (label, valor, sub = "") =>
  `<div class="card destaque"><div class="card-label">${label}</div><div class="card-valor pequeno">${valor}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;

const estadoVazio = (emoji, titulo, msg) =>
  `<div class="estado"><span class="emoji">${emoji}</span><h3>${titulo}</h3><p>${escapeHtml(msg)}</p></div>`;

const bannerErro = () =>
  state.erro ? `<div class="banner-erro">Erro ao carregar: ${escapeHtml(state.erro)}</div>` : "";

// ======================= DASHBOARD =======================
function statsDashboard(rows) {
  const comCmv = rows.filter((r) => temValor(r.cmv_pct));
  const cmvMedio = comCmv.length ? comCmv.reduce((s, r) => s + Number(r.cmv_pct), 0) / comCmv.length : null;
  const best = rows.reduce((a, b) => (Number(b.lucro_liquido ?? -Infinity) > Number(a?.lucro_liquido ?? -Infinity) ? b : a), null);
  const cmvAlto = rows.filter((r) => r._status?.chave === "critico").length;
  const semCusto = rows.filter((r) => !temValor(r.custo) || Number(r.custo) === 0).length;
  const desatualizados = rows.filter((r) => r.desatualizado).length;
  return { total: rows.length, cmvMedio, best, cmvAlto, semCusto, desatualizados };
}

// Alertas contam para o sino de notificações da topbar
export function contarAlertas(rows) {
  const s = statsDashboard(rows);
  return s.semCusto + s.cmvAlto + s.desatualizados;
}

const alertaItem = (label, valor, classe, nota = "") =>
  `<li class="alerta-item">
    <span class="alerta-dot ${classe}"></span>
    <span class="alerta-label">${label}${nota ? `<small>${nota}</small>` : ""}</span>
    <span class="alerta-valor pill ${classe}">${valor}</span>
  </li>`;

export function renderDashboard() {
  const rows = state.linhas;
  const carregando = state.carregando;
  const s = statsDashboard(rows);
  const v = (x) => (carregando ? "…" : x);
  const ctx = `${canalLabel(state.canal)} · Tabela ${fmtTexto(state.tabela)}`;

  const stMedio = statusCmv(s.cmvMedio);

  el("#view").innerHTML = `
    ${bannerErro()}

    <!-- Indicadores -->
    <p class="secao-titulo">📌 Indicadores <small>${ctx}</small></p>
    <div class="cards">
      ${card("CMV geral", v(s.cmvMedio != null ? s.cmvMedio.toFixed(1) + "%" : "—"), stMedio.classe === "bad" ? "alerta" : "", "média do catálogo")}
      ${card("Total de produtos", v(s.total), "", "com preço nesta tabela")}
      ${cardDestaque("Mais lucrativo", carregando ? "…" : (s.best ? escapeHtml(s.best.nome) : "—"), carregando || !s.best ? "" : fmtMoeda(s.best.lucro_liquido))}
    </div>

    <!-- Alertas + Últimas alterações -->
    <div class="dash-2col">
      <div class="painel">
        <div class="painel-head"><h4>⚠️ Alertas Operacionais</h4></div>
        <ul class="alerta-lista">
          ${alertaItem("Produtos sem custo", v(s.semCusto), s.semCusto > 0 ? "bad" : "ok")}
          ${alertaItem("Produtos com CMV alto", v(s.cmvAlto), s.cmvAlto > 0 ? "warn" : "ok")}
          ${alertaItem("Preços desatualizados", v(s.desatualizados), s.desatualizados > 0 ? "warn" : "ok")}
          ${alertaItem("Itens sem estoque", "—", "muted", "aguardando módulo de Estoque")}
          ${alertaItem("Custo desatualizado", "—", "muted", "aguardando Martin Brower")}
        </ul>
      </div>
      <div class="painel">
        <div class="painel-head"><h4>🕑 Últimas alterações</h4></div>
        <div class="ultimas">
          <div id="dash-ultimas" class="ultimas-lista">
            <div class="ultima-skel"></div><div class="ultima-skel"></div><div class="ultima-skel"></div>
          </div>
          <div class="ultimas-rodape">
            <span class="alerta-dot ok"></span> Sincronizado <b>${fmtHora(state.atualizadoEm)}</b> · ${s.total} produto(s)
          </div>
        </div>
      </div>
    </div>

    <!-- Gráficos -->
    <p class="secao-titulo">📊 Análise Visual</p>
    <div class="charts-grid">
      <div class="painel chart-box"><div class="painel-head"><h4>Top mais lucrativos</h4></div><div class="chart-wrap"><canvas id="chart-top"></canvas></div></div>
      <div class="painel chart-box"><div class="painel-head"><h4>Menos lucrativos</h4></div><div class="chart-wrap"><canvas id="chart-bottom"></canvas></div></div>
      <div class="painel chart-box"><div class="painel-head"><h4>Custo por categoria</h4></div><div class="chart-wrap"><canvas id="chart-custo"></canvas></div></div>
      <div class="painel chart-box"><div class="painel-head"><h4>Status de CMV</h4></div><div class="chart-wrap"><canvas id="chart-status"></canvas></div></div>
    </div>

    ${!carregando && !state.erro && !rows.length ? estadoVazio("📭", "Sem dados", "Não há produtos com preço para este canal/tabela.") : ""}
  `;

  if (!carregando && rows.length) renderGraficos(rows);
  carregarUltimasAlteracoes();
}

// ---- Painel "Últimas alterações": alimenta com o histórico real de auditoria ----
function resumoMudancas(mudancas) {
  const m0 = mudancas[0];
  const de = m0.valor_anterior == null ? "" : `<s>${escapeHtml(fmtValor(m0.campo, m0.valor_anterior))}</s> → `;
  const principal = `<span class="um-campo">${escapeHtml(m0.rotulo)}</span> ${de}<b>${escapeHtml(fmtValor(m0.campo, m0.valor_novo))}</b>`;
  const extra = mudancas.length > 1 ? ` <span class="um-mais">+${mudancas.length - 1}</span>` : "";
  return principal + extra;
}

async function carregarUltimasAlteracoes() {
  const box = el("#dash-ultimas");
  if (!box) return;
  try {
    const { data } = await obterHistoricoRecente(6);
    if (el("#dash-ultimas") !== box) return; // dashboard já foi re-renderizado

    if (data.pendente) {
      box.innerHTML = `<div class="estado-mini">O histórico de alterações começa a ser registrado assim que o módulo de auditoria for ativado no banco (migration <code>002_produto_historico.sql</code>).</div>`;
      return;
    }
    if (!data.eventos.length) {
      box.innerHTML = `<div class="estado-mini">Nenhuma alteração registrada ainda. Edições de produtos (nome, categoria, status e preços) aparecerão aqui, com autor e horário.</div>`;
      return;
    }

    box.innerHTML = data.eventos.map((e) => {
      const autor = e.usuario_nome || e.usuario_email || "Usuário";
      return `
        <button class="ultima-mudanca" data-produto="${e.produto_id}" data-nome="${escapeHtml(e.produto_nome)}" title="Ver histórico de ${escapeHtml(e.produto_nome)}">
          <span class="alerta-dot ok"></span>
          <span class="um-corpo">
            <span class="um-topo"><b class="um-produto">${escapeHtml(e.produto_nome)}</b><span class="um-quando">${fmtRelativo(e.created_at)}</span></span>
            <span class="um-detalhe">${resumoMudancas(e.mudancas)}</span>
            <span class="um-autor">por ${escapeHtml(autor)}</span>
          </span>
        </button>`;
    }).join("");

    box.querySelectorAll(".ultima-mudanca").forEach((btn) =>
      btn.addEventListener("click", () => abrirHistoricoModal(btn.dataset.produto, btn.dataset.nome)));
  } catch {
    box.innerHTML = `<div class="estado-mini">Não foi possível carregar as últimas alterações agora.</div>`;
  }
}

// ======================= PRODUTOS / CMV =======================
let _linhas = []; // linhas renderizadas (para as ações)
export function getLinha(idx) { return _linhas[Number(idx)]; }

const skeleton = (n) =>
  Array.from({ length: n }).map(() => `<tr class="skeleton-row"><td colspan="11"><span class="sk"></span></td></tr>`).join("");

const linhaEstado = (classe, emoji, titulo, msg) =>
  `<tr><td colspan="11"><div class="estado ${classe}"><span class="emoji">${emoji}</span><h3>${titulo}</h3><p>${escapeHtml(msg || "")}</p></div></td></tr>`;

const linhaProduto = (r, i) => `
  <tr>
    <td>${catLabel(r.categoria)}</td>
    <td>${canalLabel(r.canal)}</td>
    <td>${fmtTexto(r.tabela)}</td>
    <td class="prod-nome"><button class="prod-link" data-idx="${i}">${escapeHtml(r.nome)}</button>${r.desatualizado ? '<span class="badge">2024</span>' : ""}</td>
    <td>${fmtTexto(r.tamanho)}</td>
    <td class="num">${fmtMoeda(r.preco)}</td>
    <td class="num">${fmtMoeda(r.custo)}</td>
    <td class="num"><span class="pill ${r._status.classe}">${fmtPct(r.cmv_pct)}</span></td>
    <td class="num">${fmtMoeda(r.lucro_liquido)}</td>
    <td><span class="pill ${r._status.classe}">${r._status.label}</span></td>
    <td><div class="acoes">${ACOES_TABELA.map((a) => `<button class="acao-btn" data-acao="${a.chave}" data-idx="${i}" title="${a.titulo}">${a.icon}</button>`).join("")}</div></td>
  </tr>`;

export function renderTabela() {
  const tb = el("#tbody");
  if (!tb) return;
  const rc = el("#result-count");

  if (state.carregando) { tb.innerHTML = skeleton(6); if (rc) rc.textContent = ""; return; }
  if (state.erro) { tb.innerHTML = linhaEstado("erro", "⚠️", "Falha ao carregar", state.erro); if (rc) rc.textContent = ""; return; }

  const rows = linhasFiltradas();
  _linhas = rows;
  if (rc) rc.textContent = `${rows.length} de ${state.linhas.length} produtos`;

  if (!rows.length) {
    tb.innerHTML = linhaEstado("", "📭", "Nada encontrado",
      state.linhas.length ? "Ajuste a busca ou os filtros." : "Sem produtos para este canal/tabela.");
    return;
  }
  tb.innerHTML = rows.map((r, i) => linhaProduto(r, i)).join("");
}

export function renderProdutos() {
  el("#view").innerHTML = `
    ${bannerErro()}
    <div class="toolbar">
      <div class="busca"><input id="f-busca" type="search" placeholder="Buscar produto..." value="${escapeHtml(state.busca)}" /></div>
      <select id="f-status">
        <option value="todos">Todos os CMV</option>
        <option value="saudavel">🟢 Saudável</option>
        <option value="atencao">🟡 Atenção</option>
        <option value="critico">🔴 Crítico</option>
      </select>
      <button id="f-atualizar" class="btn btn-ghost btn-sm">🔄 Atualizar</button>
      <span class="result-count" id="result-count"></span>
    </div>
    <div class="tabela-wrap">
      <table class="grid">
        <thead><tr>
          <th>Categoria</th><th>Canal</th><th>Tabela</th><th>Produto</th><th>Tamanho</th>
          <th class="num">Preço</th><th class="num">Custo</th><th class="num">CMV</th>
          <th class="num">Lucro líq.</th><th>Status</th><th>Ações</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <p class="rodape">CMV = custo ÷ preço · Lucro líquido já desconta a comissão do canal · dados do seu Supabase</p>
  `;
  el("#f-status").value = state.filtroStatus;
  el("#f-busca").addEventListener("input", (e) => { state.busca = e.target.value; renderTabela(); });
  el("#f-status").addEventListener("change", (e) => { state.filtroStatus = e.target.value; renderTabela(); });
  el("#f-atualizar").addEventListener("click", () => document.dispatchEvent(new CustomEvent("app:reload")));
  renderTabela();
}

// ======================= INTEGRAÇÕES =======================
function integraCard(ig) {
  const st = STATUS_INTEGRACAO[ig.status] || STATUS_INTEGRACAO.nao_conectado;
  return `<div class="integra-card">
    <div class="integra-head">
      <div class="integra-icon">${ig.logo ? `<img src="${ig.logo}" alt="${escapeHtml(ig.nome)}" class="integra-logo" />` : ig.icon}</div>
      <div><div class="integra-nome">${ig.nome}</div><span class="pill ${st.classe}">${st.label}</span></div>
    </div>
    <div class="integra-desc">${ig.desc}</div>
    <ul class="integra-features">${ig.features.map((f) => `<li>${f}</li>`).join("")}</ul>
  </div>`;
}

export function renderIntegracoes() {
  const cards = Object.values(INTEGRACOES).map(integraCard).join("");
  el("#view").innerHTML = `
    <p class="secao-titulo">🔌 Integrações do sistema</p>
    <p style="color:var(--cinza);font-size:14px;margin:-6px 0 16px">Conforme cada integração for conectada, os dados fluem automaticamente para o painel.</p>
    <div class="integra-grid">${cards}</div>`;
}

export function renderIntegracaoDetalhe(key) {
  const ig = INTEGRACOES[key];
  if (!ig) { el("#view").innerHTML = estadoVazio("🔌", "Integração", "Não encontrada."); return; }
  el("#view").innerHTML = `<div class="integra-grid" style="grid-template-columns:minmax(0,560px)">${integraCard(ig)}</div>`;
}

// ======================= PÁGINAS EM CONSTRUÇÃO =======================
const CONSTRUCAO = {
  estoque: { emoji: "📦", desc: "Entrada, saída, perdas, vencimentos, transferências e inventário — com baixa automática por venda (o trigger já existe no banco).", planejado: ["Entrada por fornecedor", "Saída automática por venda", "Perdas e vencimentos", "Inventário"] },
  distribuidoras: { emoji: "🚚", desc: "Pedidos, entregas, notas fiscais, divergências e histórico de compras por fornecedor.", planejado: ["Pedidos de compra", "Conferência de entrega", "Notas fiscais", "Divergências"] },
  vendas: { emoji: "🧾", desc: "Consolida os fechamentos de caixa diários (SWFast) — o que vendeu e como vendeu — alimentando o CMV real e a baixa de estoque. Não registra vendas nem faz fechamento; apenas recebe e agrega.", planejado: ["Importar fechamento diário", "Mix de produtos vendidos", "CMV real x teórico", "Formas de pagamento"] },
  relatorios: { emoji: "📈", desc: "Relatórios de faturamento, CMV, margem, desperdício e comparativo entre canais.", planejado: ["Faturamento diário / mensal", "CMV por período", "Comparativo balcão x iFood"] },
  configuracoes: { emoji: "⚙️", desc: "Parâmetros da unidade: metas, tabela de preço ativa, limites de CMV e usuários.", planejado: ["Metas e limites", "Tabela ativa", "Usuários e permissões"] },
};

export function renderConstrucao(id, titulo) {
  const c = CONSTRUCAO[id] || { emoji: "🚧", desc: "Em breve.", planejado: [] };
  el("#view").innerHTML = `
    <div class="construcao">
      <span class="emoji">${c.emoji}</span>
      <h2>${titulo}</h2>
      <p>${c.desc}</p>
      <div class="planejado">${c.planejado.map((p) => `<span>→ ${p}</span>`).join("")}</div>
    </div>`;
}
