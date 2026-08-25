// Vitrine pública do cardápio (aba iFood). Mostra os produtos ao vivo, sem login de gestão.
import { carregarCmv } from "./api.js";
import { IFOOD_LOJA } from "./config.js";
import { el, fmtMoeda, escapeHtml, temValor } from "./utils.js";

// Janela da loja no iFood (card + tentativa de iframe + botão abrir).
export function montarJanelaIfood() {
  const box = el("#ifood-window");
  if (!box) return;
  const url = IFOOD_LOJA.url;
  box.innerHTML = `
    <div class="ifood-win">
      <div class="ifood-win-bar">
        <span class="ifood-badge">iFood</span>
        <div class="ifood-store">
          <div class="ifood-store-nome">${escapeHtml(IFOOD_LOJA.nome)}</div>
          <div class="ifood-store-meta">${escapeHtml(IFOOD_LOJA.nota)}</div>
        </div>
        ${url
          ? `<a class="btn ifood-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir no iFood ↗</a>`
          : `<span class="ifood-cfg">link não configurado</span>`}
      </div>
      ${url
        ? `<div class="ifood-frame">
             <iframe src="${escapeHtml(url)}" title="Loja no iFood" loading="lazy" referrerpolicy="no-referrer"></iframe>
             <p class="ifood-frame-nota">Se a prévia aparecer em branco, o iFood bloqueia a exibição embutida por segurança — use o botão "Abrir no iFood ↗".</p>
           </div>`
        : `<div class="ifood-vazio">
             <span class="emoji">🛵</span>
             <p>Cole o link da sua loja no iFood em <code>config.js → IFOOD_LOJA.url</code> para exibir a janela aqui.</p>
           </div>`}
    </div>`;
}

const CAT_LABEL = {
  sanduiche: "Sanduíches", salada: "Saladas", bebida: "Bebidas", sobremesa: "Sobremesas",
  chips: "Chips & Acompanhamentos", adicional: "Adicionais", acompanhamento: "Acompanhamentos",
  combo: "Combos", outro: "Outros",
};
const CAT_ICON = { sanduiche: "🥪", salada: "🥗", bebida: "🥤", sobremesa: "🍪", chips: "🍟", adicional: "➕", acompanhamento: "🍟", combo: "🍱", outro: "🍽️" };
const CAT_ORDEM = ["sanduiche", "salada", "adicional", "chips", "acompanhamento", "sobremesa", "bebida", "combo", "outro"];

// NOTA (auditoria da tabela comercial da unidade — ver pedido original): este
// módulo não é importado por nenhuma rota hoje (nem index.html, nem app.js,
// nem router.js) — código órfão, nunca chega a rodar. Se um dia for religado,
// NÃO reintroduza um valor fixo aqui: esta era exatamente a mesma armadilha
// (tabela hardcoded "A") que a auditoria pediu para eliminar do resto do
// app. `carregarCmv("ifood")` sem 2º argumento deixa o backend resolver a
// tabela iFood OFICIAL da unidade sozinho (ver cmv.service.js) — mas exige
// contexto de unidade (Context Token), que uma vitrine pública sem login não
// tem; decidir isso é produto, não algo pra resolver aqui.
const item = (r) => `
  <div class="cardapio-item">
    <div class="cardapio-item-info">
      <div class="cardapio-item-nome">${escapeHtml(r.nome)}</div>
      ${r.tamanho ? `<div class="cardapio-item-tam">${escapeHtml(r.tamanho)}</div>` : ""}
    </div>
    <div class="cardapio-item-preco">${fmtMoeda(r.preco)}</div>
  </div>`;

export async function montarCardapioIfood() {
  const box = el("#cardapio-live");
  if (!box) return;
  box.innerHTML = `<div class="estado"><div class="spinner"></div>Carregando cardápio…</div>`;

  try {
    const { linhas: todasLinhas } = await carregarCmv("ifood");
    const linhas = todasLinhas.filter((r) => temValor(r.preco) && Number(r.preco) > 0);
    if (!linhas.length) {
      box.innerHTML = `<div class="estado"><span class="emoji">📭</span><p>Nenhum item disponível no cardápio.</p></div>`;
      return;
    }

    const grupos = {};
    linhas.forEach((r) => { const c = r.categoria || "outro"; (grupos[c] ??= []).push(r); });
    const ordem = [
      ...CAT_ORDEM.filter((c) => grupos[c]),
      ...Object.keys(grupos).filter((c) => !CAT_ORDEM.includes(c)),
    ];

    const desat = linhas.some((r) => r.desatualizado);
    const totalItens = linhas.length;

    box.innerHTML = `
      <div class="cardapio-banner">
        <img src="/assets/logo_subway.jpeg" alt="Subway Saci" class="cardapio-logo" />
        <div>
          <div class="cardapio-banner-nome">Subway Saci</div>
          <div class="cardapio-banner-sub">${totalItens} itens${desat ? " · preços de referência" : ""}</div>
        </div>
      </div>
      ${ordem.map((cat) => `
        <div class="cardapio-secao">
          <h3 class="cardapio-cat">${CAT_ICON[cat] || "🍽️"} ${CAT_LABEL[cat] || cat}</h3>
          <div class="cardapio-grid">
            ${grupos[cat].sort((a, b) => a.nome.localeCompare(b.nome)).map(item).join("")}
          </div>
        </div>`).join("")}
    `;
  } catch (e) {
    box.innerHTML = `<div class="estado erro"><span class="emoji">⚠️</span><h3>Não foi possível carregar</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}
