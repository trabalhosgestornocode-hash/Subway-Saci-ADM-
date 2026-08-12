// Gráficos do dashboard (Chart.js via CDN). Degrada sem quebrar se offline.
const C = { verde: "#009640", verdeEsc: "#006B2D", amarelo: "#FFC72C", verm: "#DB3B3B", azul: "#3B82C4", roxo: "#7C5CD0", cinza: "#9AA5A0" };

let instancias = [];
function destruir() { instancias.forEach((c) => c.destroy()); instancias = []; }

const corta = (s, n = 16) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function renderGraficos(linhas) {
  destruir();
  if (!window.Chart || !Array.isArray(linhas) || !linhas.length) return;
  Chart.defaults.font.family = "Inter, sans-serif";
  Chart.defaults.color = "#6b7772";

  const vend = linhas.filter((r) => r.lucro_liquido != null);
  const top = [...vend].sort((a, b) => b.lucro_liquido - a.lucro_liquido).slice(0, 6);
  const bottom = [...vend].sort((a, b) => a.lucro_liquido - b.lucro_liquido).slice(0, 6);

  barraH("chart-top", top.map((r) => corta(r.nome)), top.map((r) => +r.lucro_liquido), C.verde);
  barraH("chart-bottom", bottom.map((r) => corta(r.nome)), bottom.map((r) => +r.lucro_liquido), C.amarelo);

  const porCat = {};
  linhas.forEach((r) => { const c = r.categoria || "outro"; porCat[c] = (porCat[c] || 0) + Number(r.custo || 0); });
  const catLabels = Object.keys(porCat).map((c) => c[0].toUpperCase() + c.slice(1));
  rosca("chart-custo", catLabels, Object.values(porCat).map((v) => +v.toFixed(2)), [C.verde, C.amarelo, C.verdeEsc, C.azul, C.roxo, C.cinza, C.verm]);

  const st = { "Saudável": 0, "Atenção": 0, "Crítico": 0 };
  linhas.forEach((r) => {
    const s = r._status?.chave;
    if (s === "saudavel") st["Saudável"]++;
    else if (s === "atencao") st["Atenção"]++;
    else if (s === "critico") st["Crítico"]++;
  });
  rosca("chart-status", Object.keys(st), Object.values(st), [C.verde, C.amarelo, C.verm]);
}

function barraH(id, labels, data, cor) {
  const el = document.getElementById(id);
  if (!el) return;
  instancias.push(new Chart(el, {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: cor, borderRadius: 6, maxBarThickness: 22 }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "R$ " + Number(c.raw).toFixed(2) } } },
      scales: { x: { ticks: { callback: (v) => "R$" + v }, grid: { color: "#eef1f0" } }, y: { grid: { display: false } } },
      animation: { duration: 650 },
    },
  }));
}

function rosca(id, labels, data, cores) {
  const el = document.getElementById(id);
  if (!el) return;
  instancias.push(new Chart(el, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: cores, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "60%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, padding: 12, font: { size: 11 } } } },
      animation: { duration: 650 },
    },
  }));
}

// ===========================================================================
// GRÁFICOS DO DASHBOARD EXECUTIVO — registro próprio (ciclo de vida
// independente dos gráficos do Dashboard normal acima).
// ===========================================================================
let instanciasDex = [];
export function destruirGraficosDashboardExecutivo() { instanciasDex.forEach((c) => c.destroy()); instanciasDex = []; }

const ROTULO_INDICADOR = {
  taxas_comissoes: "Taxas e comissões", servicos_promocoes: "Serviços e promoções",
  taxas_entregadores: "Taxas de entregadores", total_deducoes: "Total de deduções",
};

/** Gráfico 1 — comparativo de percentuais (atual × meta ideal × limite). */
export function barraComparativaMeta(id, itens) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !itens?.length) return;
  const labels = itens.map((i) => ROTULO_INDICADOR[i.indicador] ?? i.indicador);
  instanciasDex.push(new Chart(el, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Atual", data: itens.map((i) => i.atual ?? 0), backgroundColor: C.verde, borderRadius: 4 },
        { label: "Meta ideal", data: itens.map((i) => i.metaIdeal ?? 0), backgroundColor: C.amarelo, borderRadius: 4 },
        { label: "Limite", data: itens.map((i) => i.limite ?? 0), backgroundColor: C.verm, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.raw).toFixed(2)}%` } } },
      scales: { y: { ticks: { callback: (v) => v + "%" }, grid: { color: "#eef1f0" } } },
      animation: { duration: 650 },
    },
  }));
}

/** Gráfico 2 — composição das deduções (rosca, em R$). */
export function roscaDeducoes(id, itens) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !itens?.length) return;
  const cores = [C.verm, C.amarelo, C.azul, C.roxo];
  instanciasDex.push(new Chart(el, {
    type: "doughnut",
    data: {
      labels: itens.map((i) => ROTULO_INDICADOR[i.indicador] ?? i.indicador),
      datasets: [{ data: itens.map((i) => Math.max(i.valor, 0)), backgroundColor: cores, borderWidth: 2, borderColor: "#fff" }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "58%",
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.label}: R$ ${Number(c.raw).toFixed(2)}` } },
      },
      animation: { duration: 650 },
    },
  }));
}

/**
 * Gráfico 3 — evolução diária de um valor em R$ (diário ou acumulado).
 * Usado hoje para o Desempenho (valor_vendas_bruto) — dado operacional real
 * por dia, ao contrário do Financeiro (snapshot acumulado, não plotável
 * como série diária). `rotuloBase` nomeia o dataset/legenda.
 */
export function linhaEvolucao(id, pontos, modo = "diario", rotuloBase = "Faturamento") {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !pontos?.length) return;
  let acumulado = 0;
  const dados = pontos.map((p) => {
    if (p.valor == null) return null;
    if (modo === "acumulado") { acumulado += Number(p.valor); return acumulado; }
    return Number(p.valor);
  });
  instanciasDex.push(new Chart(el, {
    type: "line",
    data: {
      labels: pontos.map((p) => p.data.slice(8, 10)),
      datasets: [{
        label: modo === "acumulado" ? `${rotuloBase} acumulado` : `${rotuloBase} diário`,
        data: dados, borderColor: C.verde, backgroundColor: "rgba(0,150,64,0.12)", fill: true, tension: 0.25,
        spanGaps: false, pointRadius: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (c) => { const p = pontos[c[0].dataIndex]; return `${p.data.split("-").reverse().join("/")} · ${p.status}`; },
            label: (c) => c.raw == null ? "Sem lançamento" : "R$ " + Number(c.raw).toFixed(2),
          },
        },
      },
      scales: { y: { ticks: { callback: (v) => "R$" + v }, grid: { color: "#eef1f0" } } },
      animation: { duration: 650 },
    },
  }));
}

/**
 * Gráfico — evolução do Financeiro ACUMULADO (snapshots reais do iFood).
 * `pontos` é a série do mês inteiro (um item por dia, `valor: null` nos dias
 * sem snapshot) — `spanGaps:false` garante que a linha NUNCA conecta dois
 * snapshots através de um dia sem dado (nada de interpolar). Tooltip mostra
 * o acumulado até aquela data e, quando existe, o delta contra o snapshot
 * anterior do mês — mas o delta é só contexto, nunca substitui o valor
 * acumulado oficial.
 */
export function linhaFinanceiroAcumulado(id, pontos) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !pontos?.length) return;
  instanciasDex.push(new Chart(el, {
    type: "line",
    data: {
      labels: pontos.map((p) => p.data.slice(8, 10)),
      datasets: [{
        label: "Financeiro acumulado", data: pontos.map((p) => p.valor),
        borderColor: C.azul, backgroundColor: "rgba(59,130,196,0.12)", fill: true, tension: 0,
        spanGaps: false, pointRadius: 4, pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (c) => `Financeiro acumulado até ${pontos[c[0].dataIndex].data.split("-").reverse().join("/")}`,
            label: (c) => {
              const p = pontos[c.dataIndex];
              const linhas = [`R$ ${Number(p.valor).toFixed(2)}`];
              if (p.delta != null) linhas.push(`Movimento desde o snapshot anterior: ${p.delta >= 0 ? "+" : ""}R$ ${Number(p.delta).toFixed(2)}`);
              return linhas;
            },
          },
        },
      },
      scales: { y: { ticks: { callback: (v) => "R$" + v }, grid: { color: "#eef1f0" } } },
      animation: { duration: 650 },
    },
  }));
}

/**
 * Gráfico — evolução do % de deduções nos snapshots reais do Financeiro
 * (nunca um percentual "diário" — o dado de origem já é acumulado). Mesmo
 * cuidado de não interpolar do gráfico acima. Meta/limite (quando existem)
 * entram como linhas de referência tracejadas, igual ao antigo gráfico de
 * deduções diárias.
 */
export function linhaDeducoesAcumuladas(id, pontos, metaIdeal = null, limite = null) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !pontos?.length) return;
  instanciasDex.push(new Chart(el, {
    type: "line",
    data: {
      labels: pontos.map((p) => p.data.slice(8, 10)),
      datasets: [
        { label: "% deduções (acumulado)", data: pontos.map((p) => p.percentualTotalDeducoes), borderColor: C.verm, backgroundColor: "rgba(219,59,59,0.1)", fill: true, tension: 0, spanGaps: false, pointRadius: 4, pointHoverRadius: 6 },
        ...(metaIdeal != null ? [{ label: "Meta ideal", data: pontos.map(() => metaIdeal), borderColor: C.amarelo, borderDash: [6, 4], pointRadius: 0, fill: false }] : []),
        ...(limite != null ? [{ label: "Limite", data: pontos.map(() => limite), borderColor: C.roxo, borderDash: [3, 3], pointRadius: 0, fill: false }] : []),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (c) => `Deduções acumuladas até ${pontos[c[0].dataIndex].data.split("-").reverse().join("/")}`,
            label: (c) => c.raw == null ? "Sem snapshot" : `${c.dataset.label}: ${Number(c.raw).toFixed(1)}%`,
          },
        },
      },
      scales: { y: { ticks: { callback: (v) => v + "%" }, grid: { color: "#eef1f0" } } },
      animation: { duration: 650 },
    },
  }));
}

/** Gráfico 5 — comparativo mensal (faturamento, deduções, receita após deduções). */
export function barraComparativoMensal(id, meses) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !meses?.length) return;
  instanciasDex.push(new Chart(el, {
    type: "bar",
    data: {
      labels: meses.map((m) => NOME_MES_CURTO[m.mes]),
      datasets: [
        { label: "Faturamento", data: meses.map((m) => m.faturamento), backgroundColor: C.verde, borderRadius: 4 },
        { label: "Total de deduções", data: meses.map((m) => m.totalDeducoes), backgroundColor: C.verm, borderRadius: 4 },
        { label: "Receita após deduções", data: meses.map((m) => m.receitaAposDeducoes), backgroundColor: C.azul, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: R$ ${Number(c.raw).toFixed(2)}` } } },
      scales: { y: { ticks: { callback: (v) => "R$" + v }, grid: { color: "#eef1f0" } } },
      animation: { duration: 650 },
    },
  }));
}

const NOME_MES_CURTO = { 1: "Jan", 2: "Fev", 3: "Mar", 4: "Abr", 5: "Mai", 6: "Jun", 7: "Jul", 8: "Ago", 9: "Set", 10: "Out", 11: "Nov", 12: "Dez" };

// ===========================================================================
// GRÁFICOS DA BONIFICAÇÃO MENSAL — registro próprio (ciclo de vida
// independente). Paleta usa o vermelho institucional como ACCENT (marcos de
// meta), nunca como preenchimento dominante — verde/azul carregam os dados
// reais, o vermelho só marca "aqui está a meta".
// ===========================================================================
let instanciasBonif = [];
export function destruirGraficosBonificacao() { instanciasBonif.forEach((c) => c.destroy()); instanciasBonif = []; }

const CB = { real: "#0f8a4c", realBg: "rgba(15,138,76,.12)", projecao: "#8a93a6", meta: ["#f2b6b6", "#e2807f", "#DB3B3B"], mix: { bebidas: "#3B82C4", adicionais: "#FFC72C", diversos: "#7C5CD0" } };

/**
 * Evolução do faturamento ACUMULADO no mês — linha real até hoje, linha
 * pontilhada de projeção dali até o fim do mês, e uma linha horizontal fina
 * por faixa de meta de faturamento (item 3-4).
 */
export function graficoEvolucaoFaturamento(id, { calendario, faixas, mediaDiariaValida }) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !calendario?.length) return;
  const labels = calendario.map((d) => d.data.slice(8, 10));
  const idxHoje = calendario.findIndex((d) => d.status === "FUTURO") - 1;
  const ultimoIdx = idxHoje < 0 ? calendario.length - 1 : idxHoje;

  let acumulado = 0;
  const real = calendario.map((d, i) => {
    if (i > ultimoIdx) return null;
    if (d.lancamento?.faturamentoGeral != null) acumulado += Number(d.lancamento.faturamentoGeral);
    return acumulado;
  });
  const projecao = calendario.map((d, i) => {
    if (i < ultimoIdx) return null;
    if (i === ultimoIdx) return real[ultimoIdx];
    return mediaDiariaValida != null ? (real[ultimoIdx] ?? 0) + mediaDiariaValida * (i - ultimoIdx) : null;
  });

  const datasetsMeta = (faixas || []).slice(0, 3).map((f, i) => ({
    label: `Meta ${i + 1} · R$ ${Math.round(f.valorMin ?? f.valorMax).toLocaleString("pt-BR")}`,
    data: labels.map(() => f.valorMin ?? f.valorMax),
    borderColor: CB.meta[i] ?? CB.meta[2], borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false, order: 3,
  }));

  instanciasBonif.push(new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Projeção", data: projecao, borderColor: CB.projecao, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0.15, order: 2 },
        { label: "Faturamento acumulado", data: real, borderColor: CB.real, backgroundColor: CB.realBg, fill: true, tension: 0.2, pointRadius: 0, pointHoverRadius: 4, order: 1 },
        ...datasetsMeta,
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, padding: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => c.raw == null ? undefined : `${c.dataset.label}: R$ ${Number(c.raw).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}` } },
      },
      scales: {
        y: { ticks: { callback: (v) => "R$" + (v / 1000).toFixed(0) + "k" }, grid: { color: "#eef1f0" } },
        x: { grid: { display: false } },
      },
      animation: { duration: 700, easing: "easeOutQuart" },
    },
  }));
}

/** Evolução diária do mix de vendas — bebidas/adicionais/diversos (item 6). */
export function graficoEvolucaoMix(id, calendario) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !calendario?.length) return;
  const comDado = calendario.filter((d) => d.lancamento?.mix?.bebidas != null);
  if (!comDado.length) return;
  const labels = calendario.map((d) => d.data.slice(8, 10));
  const serie = (chave) => calendario.map((d) => d.lancamento?.mix?.[chave] ?? null);

  instanciasBonif.push(new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Bebidas", data: serie("bebidas"), borderColor: CB.mix.bebidas, backgroundColor: "transparent", tension: 0.25, pointRadius: 2, spanGaps: true },
        { label: "Adicionais", data: serie("adicionais"), borderColor: CB.mix.adicionais, backgroundColor: "transparent", tension: 0.25, pointRadius: 2, spanGaps: true },
        { label: "Diversos", data: serie("diversos"), borderColor: CB.mix.diversos, backgroundColor: "transparent", tension: 0.25, pointRadius: 2, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, padding: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => c.raw == null ? undefined : `${c.dataset.label}: ${Number(c.raw).toFixed(1)}%` } },
      },
      scales: { y: { ticks: { callback: (v) => v + "%" }, grid: { color: "#eef1f0" } }, x: { grid: { display: false } } },
      animation: { duration: 700, easing: "easeOutQuart" },
    },
  }));
}

/** Gráfico 6 — visão anual (12 meses: faturamento, deduções, receita, % deduções). */
export function visaoAnual(id, meses) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !meses?.length) return;
  instanciasDex.push(new Chart(el, {
    data: {
      labels: meses.map((m) => NOME_MES_CURTO[m.mes]),
      datasets: [
        { type: "bar", label: "Faturamento", data: meses.map((m) => (m.status === "futuro" ? null : m.faturamento)), backgroundColor: C.verde, borderRadius: 4, order: 2 },
        { type: "bar", label: "Receita após deduções", data: meses.map((m) => (m.status === "futuro" ? null : m.receitaAposDeducoes)), backgroundColor: C.azul, borderRadius: 4, order: 2 },
        { type: "line", label: "% deduções", data: meses.map((m) => (m.status === "futuro" ? null : m.percentualDeducoes)), borderColor: C.verm, yAxisID: "y1", tension: 0.25, order: 1, spanGaps: false, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            afterTitle: (c) => { const m = meses[c[0].dataIndex]; return m.status === "incompleto" ? "⚠ mês com dados incompletos" : m.status === "sem_dados" ? "sem lançamentos" : ""; },
          },
        },
      },
      scales: {
        y: { position: "left", ticks: { callback: (v) => "R$" + v }, grid: { color: "#eef1f0" } },
        y1: { position: "right", ticks: { callback: (v) => v + "%" }, grid: { display: false } },
      },
      animation: { duration: 650 },
    },
  }));
}
