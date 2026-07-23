// Filtro de itens fora do escopo operacional da loja (seção 8 da spec).
//
// O que ENTRA: alimentos, bebidas, embalagens, descartáveis, itens operacionais.
// O que é IGNORADO: uniformes, roupas e acessórios de vestuário.
//
// "Ignorar" aqui NUNCA significa apagar. O produto continua sendo gravado, com
// ignorado = true, motivo_ignorado e regra_ignorado — auditável e reversível.
// Um administrador pode sobrepor a classificação (classificacao_manual), e daí
// em diante o filtro automático respeita a decisão humana.

// Regras PADRÃO da plataforma. Regras adicionais por organização/unidade vêm
// da tabela martin_brower_filtros e são aplicadas por cima destas.
export const PALAVRAS_UNIFORME = [
  "uniforme", "camiseta", "camisa", "polo", "calca", "calça", "bermuda",
  "avental", "bone", "boné", "chapeu", "chapéu", "jaleco",
  "japona", "casaco", "blusa", "colete", "sapato", "sapatilha", "tenis",
  "tênis", "calcado", "calçado", "bota", "luva de malha",
  "cinto", "gravata", "crachá", "cracha", "vestuario", "vestuário",
];

// DELIBERADAMENTE FORA da lista padrão, apesar de soarem "vestuário":
//   * "meia"  — casaria com "PÃO MEIA LUA", produto real da Subway;
//   * "touca" — touca descartável é EPI de cozinha, item operacional;
//   * "luva"  — luva descartável idem (só "luva de malha" é ignorada).
// Quem quiser excluí-los cria uma regra custom em martin_brower_filtros.

export const FAMILIAS_IGNORADAS = ["UNI", "VES"];       // uniforme / vestuário
export const GRUPOS_IGNORADOS = ["UNIFORME", "VESTUARIO", "VESTUÁRIO", "ROUPAS"];

// Normaliza texto para comparação: sem acento, minúsculo, espaços colapsados.
export function normalizarTexto(v) {
  return String(v ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

// Casa palavra inteira — evita "bota" dentro de "garrafa" ou "bone" em "carbonell".
function contemPalavra(texto, palavra) {
  const alvo = normalizarTexto(palavra);
  if (!alvo) return false;
  const re = new RegExp(`(^|[^a-z0-9])${alvo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  return re.test(texto);
}

/**
 * Constrói um filtro a partir das regras padrão + regras customizadas do banco.
 * @param {Array<{tipo,valor,acao,motivo}>} regrasCustom linhas de martin_brower_filtros
 */
export function criarFiltro(regrasCustom = []) {
  const custom = { ignorar: [], incluir: [] };
  for (const r of regrasCustom) {
    if (!r?.tipo || !r?.valor) continue;
    const balde = r.acao === "incluir" ? custom.incluir : custom.ignorar;
    balde.push({ tipo: r.tipo, valor: normalizarTexto(r.valor), valorCru: String(r.valor).trim(), motivo: r.motivo ?? null });
  }

  // Uma regra casa com o produto?
  function casa(regra, produto) {
    const desc = normalizarTexto(produto.descricao);
    switch (regra.tipo) {
      case "codigo":       return String(produto.codigo).trim() === regra.valorCru;
      case "grupo":        return normalizarTexto(produto.grupoDescricao).includes(regra.valor);
      case "familia":      return normalizarTexto(produto.familia) === regra.valor
                                || normalizarTexto(produto.familiaDescricao).includes(regra.valor);
      case "descricao":    return desc.includes(regra.valor);
      case "palavra_chave":return contemPalavra(desc, regra.valor);
      default:             return false;
    }
  }

  /**
   * Classifica um produto normalizado.
   * @returns {{ignorado: boolean, motivo: string|null, regra: string|null}}
   */
  function classificar(produto) {
    // 1. "incluir" tem precedência absoluta: é o administrador dizendo
    //    explicitamente que este item pertence ao escopo.
    for (const r of custom.incluir) {
      if (casa(r, produto)) return { ignorado: false, motivo: null, regra: `custom:incluir:${r.tipo}` };
    }

    // 2. Regras customizadas de exclusão.
    for (const r of custom.ignorar) {
      if (casa(r, produto)) {
        return { ignorado: true, motivo: r.motivo ?? `Regra da loja: ${r.tipo} "${r.valorCru}"`, regra: `custom:ignorar:${r.tipo}` };
      }
    }

    // 3. Regras padrão da plataforma — família.
    const familia = normalizarTexto(produto.familia).toUpperCase();
    if (FAMILIAS_IGNORADAS.includes(familia)) {
      return { ignorado: true, motivo: `Família "${produto.familia}" fora do escopo operacional`, regra: "padrao:familia" };
    }

    // 4. Grupo.
    const grupo = normalizarTexto(produto.grupoDescricao);
    for (const g of GRUPOS_IGNORADOS) {
      if (grupo.includes(normalizarTexto(g))) {
        return { ignorado: true, motivo: `Grupo "${produto.grupoDescricao}" fora do escopo operacional`, regra: "padrao:grupo" };
      }
    }

    // 5. Palavras-chave de vestuário na descrição.
    const desc = normalizarTexto(produto.descricao);
    for (const palavra of PALAVRAS_UNIFORME) {
      if (contemPalavra(desc, palavra)) {
        return { ignorado: true, motivo: `Item de uniforme/vestuário (termo "${palavra}")`, regra: "padrao:palavra_chave" };
      }
    }

    return { ignorado: false, motivo: null, regra: null };
  }

  return { classificar };
}

/**
 * Aplica o filtro à lista normalizada. NÃO remove nada: anota a classificação
 * em cada produto e devolve a lista completa mais os contadores.
 */
export function aplicarFiltros(produtos, regrasCustom = []) {
  const filtro = criarFiltro(regrasCustom);
  let ignorados = 0;

  const classificados = produtos.map((p) => {
    const c = filtro.classificar(p);
    if (c.ignorado) ignorados += 1;
    return { ...p, ignorado: c.ignorado, motivoIgnorado: c.motivo, regraIgnorado: c.regra };
  });

  return { produtos: classificados, validos: classificados.length - ignorados, ignorados };
}
