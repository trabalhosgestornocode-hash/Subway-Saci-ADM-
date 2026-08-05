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

/** Gráfico 3 — evolução diária do faturamento (diário ou acumulado). */
export function linhaEvolucao(id, pontos, modo = "diario") {
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
        label: modo === "acumulado" ? "Faturamento acumulado" : "Faturamento diário",
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

/** Gráfico 4 — evolução do percentual total de deduções, com meta e limite. */
export function linhaEvolucaoDeducoes(id, pontos) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !pontos?.length) return;
  const metaIdeal = pontos.find((p) => p.metaIdeal != null)?.metaIdeal ?? null;
  const limite = pontos.find((p) => p.limite != null)?.limite ?? null;
  instanciasDex.push(new Chart(el, {
    type: "line",
    data: {
      labels: pontos.map((p) => p.data.slice(8, 10)),
      datasets: [
        { label: "% total de deduções", data: pontos.map((p) => p.percentualTotalDeducoes), borderColor: C.verde, backgroundColor: "rgba(0,150,64,0.1)", fill: true, tension: 0.25, spanGaps: false, pointRadius: 2 },
        ...(metaIdeal != null ? [{ label: "Meta ideal", data: pontos.map(() => metaIdeal), borderColor: C.amarelo, borderDash: [6, 4], pointRadius: 0, fill: false }] : []),
        ...(limite != null ? [{ label: "Limite", data: pontos.map(() => limite), borderColor: C.verm, borderDash: [3, 3], pointRadius: 0, fill: false }] : []),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => c.raw == null ? "Sem lançamento" : `${c.dataset.label}: ${Number(c.raw).toFixed(1)}%` } } },
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
        { label: "Faturamento bruto", data: meses.map((m) => m.faturamentoBruto), backgroundColor: C.verde, borderRadius: 4 },
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

/** Gráfico 6 — visão anual (12 meses: faturamento, deduções, receita, % deduções). */
export function visaoAnual(id, meses) {
  const el = document.getElementById(id);
  if (!el || !window.Chart || !meses?.length) return;
  instanciasDex.push(new Chart(el, {
    data: {
      labels: meses.map((m) => NOME_MES_CURTO[m.mes]),
      datasets: [
        { type: "bar", label: "Faturamento bruto", data: meses.map((m) => (m.status === "futuro" ? null : m.faturamentoBruto)), backgroundColor: C.verde, borderRadius: 4, order: 2 },
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
