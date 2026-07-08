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
