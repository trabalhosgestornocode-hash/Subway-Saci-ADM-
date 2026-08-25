// Aba de lançamento manual DIÁRIO — REV, Pesquisas, Nota iFood e Pedidos com
// Chamado (item 76-B): indicadores sem fonte automática confiável, mas com
// o MESMO acompanhamento dia a dia da Visio (calendário do mês, um dia de
// cada vez) — não um valor único por mês. Cada indicador tem sua PRÓPRIA
// aba em bonificacaoMensal.js (nunca um formulário genérico misturando os
// 4); este arquivo é só UM renderer reaproveitado pelas 4, parametrizado
// pela chave do indicador (DRY na implementação, sem misturar a tela).
// Mesmo padrão de bonificacaoMensalImportModal.js: standalone, nunca
// importa de bonificacaoMensal.js (evita import circular).
import { escapeHtml, toast, fmtMoeda, fmtPct } from "./utils.js";
import { bonifCalendarioIndicador, bonifHistoricoMensalIndicador, bonifSalvarValorDiaIndicador } from "./api.js";
import { geracaoContexto, contextoMudou } from "./contextoEscopo.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

/** Metadado de exibição de cada indicador manual — fonte única aqui, não espalhar pelo componente. */
const CAMPO_INFO = {
  // 'rev' saiu daqui na migration 052 — virou mensal de verdade, tem aba
  // própria em bonificacaoMensal.js (renderRevMensal), não usa mais este
  // renderer diário.
  pesquisas: {
    label: "Pesquisas", icon: "📝", tipo: "int", step: "1", placeholder: "Ex.: 6",
    ajuda: "Quantidade de pesquisas respondidas NESTE DIA. O mês soma como TOTAL acumulado dos dias lançados.",
  },
  avaliacao_ifood: {
    label: "Nota iFood", icon: "⭐", tipo: "nota", step: "0.1", placeholder: "Ex.: 4,8",
    ajuda: "Avaliação da loja no iFood no dia. O mês soma como MÉDIA dos dias lançados.",
  },
  pedidos_chamado: {
    label: "Pedidos com Chamado", icon: "☎️", tipo: "pct", step: "0.1", placeholder: "Ex.: 2,1",
    ajuda: "Percentual de pedidos com chamado no dia — quanto MENOR, melhor. O mês soma como MÉDIA dos dias lançados.",
  },
  cancelamentos: {
    label: "Cancelamentos", icon: "🚫", tipo: "pct", step: "0.1", placeholder: "Ex.: 0,8",
    ajuda: "Percentual de pedidos cancelados no dia — quanto MENOR, melhor. Sem fonte automática comprovada ainda. O mês soma como MÉDIA dos dias lançados.",
  },
};

const STATUS_DIA_LEGENDA = [
  { chave: "PREENCHIDO", label: "Lançado", classe: "ok" },
  { chave: "PENDENTE", label: "Pendente", classe: "bad" },
  { chave: "SEM_OPERACAO", label: "Sem operação", classe: "muted" },
  { chave: "FUTURO", label: "Futuro", classe: "muted" },
];
const STATUS_DIA_ROTULO = Object.fromEntries(STATUS_DIA_LEGENDA.map((s) => [s.chave, s]));

function fmtValor(valor, tipo) {
  if (valor == null) return "—";
  if (tipo === "moeda") return fmtMoeda(valor);
  if (tipo === "pct") return fmtPct(valor);
  if (tipo === "nota") return Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return Number(valor).toLocaleString("pt-BR");
}
const fmtDataBr = (iso) => iso?.split("-").reverse().join("/") ?? "—";
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
const vazioErro = (msg) => `<div class="estado"><span class="emoji">⚠️</span><h3>Erro</h3><p>${escapeHtml(msg)}</p></div>`;

/**
 * @param {HTMLElement} box
 * @param {'rev'|'pesquisas'|'avaliacao_ifood'|'pedidos_chamado'} indicador
 * @param {{ano:number, mes:number, unidadeNome:string, podeLancar:boolean}} ctx
 */
export async function renderIndicadorManualTab(box, indicador, ctx) {
  const info = CAMPO_INFO[indicador];
  box.innerHTML = carregando();
  const g = geracaoContexto();
  try {
    const [{ data: cal }, { data: historico }] = await Promise.all([
      bonifCalendarioIndicador(indicador, { ano: ctx.ano, mes: ctx.mes }),
      bonifHistoricoMensalIndicador(indicador, { meses: 6 }),
    ]);
    if (contextoMudou(g)) return;
    const contagem = {};
    for (const d of cal.dias) contagem[d.status] = (contagem[d.status] || 0) + 1;

    box.innerHTML = `
      <section class="bm-secao">
        <h3 class="bm-secao-titulo">${info.icon} ${info.label} — ${MESES[cal.mes - 1]}/${cal.ano}</h3>
        <p class="bm-vazio-inline">${escapeHtml(info.ajuda)}</p>
        ${cardAgregadoHtml(info, cal.agregado)}
      </section>
      <section class="bm-secao">
        <h3 class="bm-secao-titulo">🗓️ Lançamento diário</h3>
        <div class="bm-cal-resumo">
          ${STATUS_DIA_LEGENDA.map((s) => `<div class="bm-cal-resumo-item"><span class="pill ${s.classe}">${contagem[s.chave] || 0}</span><small>${s.label}</small></div>`).join("")}
        </div>
        <section class="dex-cal-wrap"><div class="dex-cal">${cal.dias.map((d) => diaHtml(info, d)).join("")}</div></section>
        <div id="bm-ind-editor"></div>
      </section>
      ${historicoHtml(info, historico)}
    `;
    box.querySelectorAll(".dex-cal-dia[data-dia]").forEach((elDia) => elDia.addEventListener("click", () => {
      if (!ctx.podeLancar) return;
      const dia = cal.dias.find((d) => d.data === elDia.dataset.dia);
      abrirEditorDia(box, indicador, dia, ctx, info);
    }));
  } catch (e) {
    if (contextoMudou(g)) return;
    box.innerHTML = vazioErro(e.message);
  }
}

function cardAgregadoHtml(info, agregado) {
  if (agregado.status === "sem_dados") {
    return `<div class="bm-card bm-gauge-card neutro"><div class="bm-card-topo"><span>${info.icon}</span> ${info.label} — mês</div>
      <p class="bm-vazio-inline">Dados não informados</p></div>`;
  }
  return `<div class="bm-card bm-gauge-card">
    <div class="bm-card-topo"><span>${info.icon}</span> ${info.label} — mês
      ${agregado.status === "sem_meta" ? `<span class="pill muted">sem meta cadastrada</span>` : ""}
    </div>
    <div class="bm-gauge-valor">${fmtValor(agregado.valorAtual, info.tipo)}</div>
    <div class="bm-gauge-detalhe">
      <span>Faixa atingida: <b>${agregado.bonusAtual == null ? "—" : fmtMoeda(agregado.bonusAtual)}</b></span>
      ${agregado.proximaFaixa
        ? `<span>Próxima faixa: <b>${fmtValor(agregado.proximaFaixa.valorMin ?? agregado.proximaFaixa.valorMax, info.tipo)}</b> (+${fmtMoeda(agregado.bonusProximaFaixa)}) · faltam ${fmtValor(Math.abs(agregado.faltante), info.tipo)}</span>`
        : agregado.status === "meta_maxima" ? `<span>Faixa máxima atingida 🎉</span>` : ""}
    </div>
  </div>`;
}

function diaHtml(info, dia) {
  const s = STATUS_DIA_ROTULO[dia.status] ?? { label: dia.status, classe: "muted" };
  const numero = Number(dia.data.slice(8, 10));
  const clicavel = dia.status === "PREENCHIDO" || dia.status === "PENDENTE";
  const valorTxt = dia.valor != null ? fmtValor(dia.valor, info.tipo) : s.label;
  return `<div class="dex-cal-dia pill ${s.classe}" ${clicavel ? `data-dia="${dia.data}" role="button" tabindex="0"` : ""} title="${fmtDataBr(dia.data)} · ${s.label}${dia.valor != null ? " · " + fmtValor(dia.valor, info.tipo) : ""}">
    <span class="dex-cal-num">${numero}</span><span class="dex-cal-status">${valorTxt}</span>
  </div>`;
}

function abrirEditorDia(box, indicador, dia, ctx, info) {
  const area = box.querySelector("#bm-ind-editor");
  if (!area) return;
  area.innerHTML = `<div class="bm-card">
    <h4>✏️ ${fmtDataBr(dia.data)}</h4>
    <form id="bm-ind-dia-form" class="cfg-form-grid">
      <label class="cfg-campo"><span>${info.label}</span>
        <input type="number" step="${info.step}" min="0" id="bm-ind-dia-valor" value="${dia.valor ?? ""}" placeholder="${info.placeholder}" required></label>
      <div class="ed-acoes">
        <button type="button" class="btn btn-ghost" id="bm-ind-dia-cancelar">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  </div>`;
  area.querySelector("#bm-ind-dia-cancelar").addEventListener("click", () => { area.innerHTML = ""; });
  area.querySelector("#bm-ind-dia-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const valor = area.querySelector("#bm-ind-dia-valor").value;
    if (valor === "") return toast("Informe um valor.");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await bonifSalvarValorDiaIndicador(indicador, { data: dia.data, valor });
      toast("Lançamento salvo ✅");
      await renderIndicadorManualTab(box, indicador, ctx);
    } catch (err) {
      toast("Erro: " + err.message);
      btn.disabled = false;
    }
  });
  area.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function historicoHtml(info, historico) {
  if (!historico?.length) return "";
  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">📚 Últimos meses</h3>
    <div class="tabela-wrap"><table class="grid">
      <thead><tr><th>Mês</th><th class="num">Valor do mês</th><th>Faixa</th><th class="num">Bonificação</th></tr></thead>
      <tbody>${historico.map((h) => `<tr>
        <td>${MESES[h.mes - 1]}/${h.ano}</td>
        <td class="num">${fmtValor(h.valorAtual, info.tipo)}</td>
        <td>${h.status === "sem_dados" ? "sem dados" : h.status === "sem_meta" ? "sem meta" : h.faixaAtual ? `faixa ${h.faixaAtual.ordem}` : h.status === "meta_nao_atingida" ? "meta não atingida" : "—"}</td>
        <td class="num">${h.bonusAtual == null ? "—" : fmtMoeda(h.bonusAtual)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </section>`;
}
