// Tela de seleção de ambiente (pós-login): agrupamento por empresa, busca
// instantânea e "acessados recentemente". Extraído de app.js — mesmo padrão
// de módulo por tela que adminUi.js/adminViews.js já usam.
//
// POR QUE UM MÓDULO À PARTE: a lista de acessos deixou de caber numa lista
// vertical simples (dezenas de empresas, cada uma com várias unidades).
// app.js continua dono do FLUXO (quando mostrar a tela, o que fazer ao
// entrar); este módulo só sabe desenhar e filtrar a lista.
//
// "Recentes" fica em localStorage (não sessionStorage): precisa sobreviver a
// fechar a aba e a um novo login, mas é só uma conveniência de navegação —
// não é dado de sessão, não precisa do backend, e cada usuário vê só o seu
// (chave prefixada pelo id).

import { el, escapeHtml, normalizarBusca } from "./utils.js";

const MAX_RECENTES = 5;
const chaveRecentes = (usuarioId) => `cd.recentes.${usuarioId}`;

const chaveOpcao = (o) => `${o.organizacaoId}:${o.unidadeId ?? ""}`;

/**
 * Registra um acesso bem-sucedido no histórico local do usuário — mais
 * recente primeiro, sem duplicar a mesma empresa/unidade, capado em
 * MAX_RECENTES. Chamado por app.js#entrarNoContexto.
 * @param {string|undefined} usuarioId
 * @param {object} opcao
 */
export function registrarAcessoRecente(usuarioId, opcao) {
  if (!usuarioId) return;
  const chave = chaveRecentes(usuarioId);
  let lista = lerRecentes(usuarioId);
  lista = lista.filter((r) => chaveOpcao(r) !== chaveOpcao(opcao));
  lista.unshift({
    organizacaoId: opcao.organizacaoId,
    unidadeId: opcao.unidadeId ?? null,
    em: Date.now(),
  });
  try {
    localStorage.setItem(chave, JSON.stringify(lista.slice(0, MAX_RECENTES)));
  } catch {
    /* localStorage indisponível/cheio — recentes é só conveniência, não é crítico */
  }
}

function lerRecentes(usuarioId) {
  if (!usuarioId) return [];
  try {
    const bruto = JSON.parse(localStorage.getItem(chaveRecentes(usuarioId)) || "[]");
    return Array.isArray(bruto) ? bruto : [];
  } catch {
    return [];
  }
}

/** Agrupa as opções (uma por unidade, ou uma por empresa quando o acesso é no nível dela) por empresa. */
function agruparPorEmpresa(opcoes) {
  const mapa = new Map();
  for (const o of opcoes) {
    if (!mapa.has(o.organizacaoId)) {
      mapa.set(o.organizacaoId, {
        organizacaoId: o.organizacaoId,
        empresaNome: o.empresaNome,
        logoUrl: o.logoUrl,
        acessivel: o.acessivel,
        motivo: o.motivo,
        unidades: [],
      });
    }
    mapa.get(o.organizacaoId).unidades.push(o);
  }
  return [...mapa.values()].sort((a, b) => a.empresaNome.localeCompare(b.empresaNome, "pt-BR"));
}

/** A opção casa com o termo de busca? Procura por empresa, unidade, cidade, cargo e CNPJ. */
function corresponde(opcao, termoNormalizado) {
  if (!termoNormalizado) return true;
  const alvo = [opcao.empresaNome, opcao.unidadeNome, opcao.cidade, opcao.papelRotulo, opcao.cnpj]
    .filter(Boolean)
    .map(normalizarBusca)
    .join(" | ");
  return alvo.includes(termoNormalizado);
}

/** Texto do contador no topo — "Você está associado a N empresas · M unidades disponíveis". */
function contagemTexto(nEmpresas, nUnidades) {
  const plural = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;
  let txt = `Você está associado a ${plural(nEmpresas, "empresa", "empresas")}`;
  if (nUnidades) txt += ` · ${plural(nUnidades, "unidade disponível", "unidades disponíveis")}`;
  return txt;
}

function logoHtml(nome, logoUrl) {
  return logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" class="sel-logo" />`
    : `<span class="sel-logo sel-logo--txt">${escapeHtml((nome[0] || "?").toUpperCase())}</span>`;
}

/** Card de acesso direto — grupo com uma única opção (empresa consolidada ou unidade única). */
function cardSimplesHtml(o) {
  const sub = o.unidadeNome ? `${o.unidadeNome} · ${o.papelRotulo}` : o.papelRotulo;
  return `
    <article class="sel-card ${o.acessivel ? "" : "sel-card--off"}" role="listitem">
      <div class="sel-card-head">
        ${logoHtml(o.empresaNome, o.logoUrl)}
        <div class="sel-card-id">
          <b>${escapeHtml(o.empresaNome)}</b>
          <small>${escapeHtml(sub)}</small>
        </div>
      </div>
      ${o.cidade ? `<p class="sel-card-linha">📍 ${escapeHtml(o.cidade)}</p>` : ""}
      ${o.acessivel ? "" : `<span class="pill bad">${escapeHtml(o.motivo ?? "Indisponível")}</span>`}
      <button type="button" class="btn ${o.acessivel ? "btn-primary" : "btn-ghost"} sel-btn"
              data-org="${escapeHtml(o.organizacaoId)}" data-uni="${escapeHtml(o.unidadeId ?? "")}"
              ${o.acessivel ? "" : "disabled"}>
        ${o.acessivel ? "Acessar" : "Bloqueada"}
      </button>
    </article>`;
}

/** Uma linha de unidade dentro do card de empresa multi-unidade (revelada ao expandir). */
function linhaUnidadeHtml(o) {
  const sub = [o.papelRotulo, o.cidade].filter(Boolean).join(" · ");
  return `
    <div class="sel-uni ${o.acessivel ? "" : "sel-uni--off"}">
      <div class="sel-uni-info">
        <b>${escapeHtml(o.unidadeNome || o.empresaNome)}</b>
        <small>${escapeHtml(sub)}</small>
      </div>
      <button type="button" class="btn ${o.acessivel ? "btn-primary" : "btn-ghost"} btn-sm sel-btn"
              data-org="${escapeHtml(o.organizacaoId)}" data-uni="${escapeHtml(o.unidadeId ?? "")}"
              ${o.acessivel ? "" : "disabled"}>
        ${o.acessivel ? "Acessar" : "Bloqueada"}
      </button>
    </div>`;
}

/** Card de empresa com 2+ unidades — expansível: revela as unidades dentro do próprio card. */
function cardGrupoHtml(grupo, aberto) {
  const qtd = grupo.unidades.length;
  const papeis = [...new Set(grupo.unidades.map((u) => u.papelRotulo).filter(Boolean))];
  const papelComum = papeis.length === 1 ? papeis[0] : null;
  return `
    <article class="sel-card sel-card--grupo ${aberto ? "sel-card--aberto" : ""} ${grupo.acessivel ? "" : "sel-card--off"}" role="listitem">
      <div class="sel-card-head">
        ${logoHtml(grupo.empresaNome, grupo.logoUrl)}
        <div class="sel-card-id">
          <b>${escapeHtml(grupo.empresaNome)}</b>
          <small>${qtd} unidades${papelComum ? ` · ${escapeHtml(papelComum)}` : ""}</small>
        </div>
      </div>
      ${grupo.acessivel ? "" : `<span class="pill bad">${escapeHtml(grupo.motivo ?? "Indisponível")}</span>`}
      <button type="button" class="sel-card-exp" data-toggle-org="${escapeHtml(grupo.organizacaoId)}"
              aria-expanded="${aberto}">
        <span>${aberto ? "Ocultar unidades" : `Ver unidades (${qtd})`}</span>
        <span class="sel-card-seta" aria-hidden="true">▾</span>
      </button>
      <div class="sel-card-unis" ${aberto ? "" : "hidden"}>
        ${grupo.unidades.map(linhaUnidadeHtml).join("")}
      </div>
    </article>`;
}

/** Grupo com 2+ unidades: card expansível. Grupo com 1 opção: card simples. */
function grupoHtml(grupo, aberto) {
  return grupo.unidades.length === 1
    ? cardSimplesHtml(grupo.unidades[0])
    : cardGrupoHtml(grupo, aberto);
}

function encontrarOpcao(opcoes, organizacaoId, unidadeId) {
  const uni = unidadeId || null;
  return opcoes.find((o) => o.organizacaoId === organizacaoId && (o.unidadeId ?? null) === uni) ?? null;
}

/**
 * Monta a tela de seleção dentro de #sel-lista (+ busca e recentes). Chamado
 * uma vez a cada exibição da tela (login novo, "Trocar unidade" etc.).
 * @param {{opcoes: Array<object>, superadmin: boolean}} dados
 * @param {{usuarioId: string|undefined, onEntrar: (opcao: object, botao?: HTMLElement) => void}} opts
 */
export function montarSelecao(dados, { usuarioId, onEntrar }) {
  const buscaWrap = el("#sel-busca-wrap");
  const buscaInput = el("#sel-busca");
  const recentesBox = el("#sel-recentes");
  const contagem = el("#sel-contagem");
  const lista = el("#sel-lista");

  if (!dados.opcoes.length) {
    buscaWrap.hidden = true;
    recentesBox.hidden = true;
    if (contagem) contagem.hidden = true;
    lista.innerHTML = "";
    return;
  }

  // Grupos com 2+ unidades começam FECHADOS (evita rolagem gigante com
  // dezenas de empresas) — exceto quando existe só uma empresa no total,
  // caso em que colapsar não ajuda ninguém.
  const grupos = agruparPorEmpresa(dados.opcoes);
  const expandido = new Set(grupos.length === 1 ? grupos.map((g) => g.organizacaoId) : []);

  // Contador de empresas/unidades — nº de empresas = grupos; nº de unidades =
  // opções com unidadeId (a opção consolidada de empresa sem unidade não conta).
  if (contagem) {
    const nUnidades = dados.opcoes.filter((o) => o.unidadeId).length;
    contagem.textContent = contagemTexto(grupos.length, nUnidades);
    contagem.hidden = false;
  }

  const buscaVale = dados.opcoes.length > 4; // com pouquíssimos acessos, busca só atrapalha
  buscaWrap.hidden = !buscaVale;
  if (!buscaVale) buscaInput.value = "";

  function renderRecentes() {
    const recentes = lerRecentes(usuarioId)
      .map((r) => encontrarOpcao(dados.opcoes, r.organizacaoId, r.unidadeId))
      .filter((o) => o && o.acessivel);
    recentesBox.hidden = !recentes.length;
    if (!recentes.length) return;
    recentesBox.innerHTML = `
      <small class="sel-recentes-titulo">Acessados recentemente</small>
      <div class="sel-recentes-chips">
        ${recentes.map((o) => `
          <button type="button" class="sel-recente-chip" data-org="${escapeHtml(o.organizacaoId)}" data-uni="${escapeHtml(o.unidadeId ?? "")}">
            ${logoHtml(o.empresaNome, o.logoUrl)}
            <span>${escapeHtml(o.unidadeNome || o.empresaNome)}</span>
          </button>`).join("")}
      </div>`;
  }

  function renderLista() {
    const termo = normalizarBusca(buscaInput.value.trim());
    const filtrados = termo
      ? grupos
          .map((g) => ({ ...g, unidades: g.unidades.filter((o) => corresponde(o, termo)) }))
          .filter((g) => g.unidades.length)
      : grupos;

    if (!filtrados.length) {
      lista.innerHTML = `
        <div class="sel-vazio">
          <span class="sel-vazio-ic">🔎</span>
          <h3>Nada encontrado</h3>
          <p>Nenhuma empresa ou unidade corresponde a "${escapeHtml(buscaInput.value.trim())}".</p>
        </div>`;
      return;
    }

    // Buscando, todo grupo com resultado abre sozinho — não faz sentido
    // achar uma unidade e ainda precisar clicar para revelar o card.
    lista.innerHTML = filtrados
      .map((g) => grupoHtml(g, termo ? true : expandido.has(g.organizacaoId)))
      .join("");
  }

  // Delegação única nos containers — sobrevive a re-renders (só reescrevem
  // innerHTML) sem acumular listeners duplicados a cada vez que a tela abre.
  lista.onclick = (e) => {
    const toggle = e.target.closest("[data-toggle-org]");
    if (toggle) {
      const org = toggle.dataset.toggleOrg;
      if (expandido.has(org)) expandido.delete(org); else expandido.add(org);
      renderLista();
      return;
    }
    const btn = e.target.closest(".sel-btn");
    if (!btn || btn.disabled) return;
    const opcao = encontrarOpcao(dados.opcoes, btn.dataset.org, btn.dataset.uni);
    if (opcao) onEntrar(opcao, btn);
  };

  recentesBox.onclick = (e) => {
    const chip = e.target.closest(".sel-recente-chip");
    if (!chip) return;
    const opcao = encontrarOpcao(dados.opcoes, chip.dataset.org, chip.dataset.uni);
    if (opcao) onEntrar(opcao, null);
  };

  buscaInput.oninput = renderLista;

  renderRecentes();
  renderLista();
}
