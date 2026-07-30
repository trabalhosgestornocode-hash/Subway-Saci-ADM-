// Camada de cálculo do CMV — FONTE ÚNICA das fórmulas de custo.
//
// Regra do projeto: as fórmulas NÃO se espalham por controllers e telas. Tudo
// que envolve conversão de unidade, custo de insumo, custo proporcional, custo
// de produto, CMV e margem mora aqui — puro, sem I/O, testável isoladamente.
// O backend valida e recalcula por cima disto; o frontend só mostra prévias.
//
// PRECISÃO: os cálculos internos guardam toda a precisão (custo por grama pode
// ter muitas casas). Arredonda-se só na EXIBIÇÃO. Não arredondar componente a
// componente cedo demais evita divergência no total.

/**
 * Unidades de medida suportadas na 1ª versão.
 * `un` cobre itens discretos; `fatia`/`porcao`/`folha` são discretos legados
 * (existem no enum do banco) e só convertem entre si mesmos.
 */
export const UNIDADES = ["un", "g", "kg", "ml", "l", "fatia", "porcao", "folha"];

/** Rótulos pt-BR para as unidades. */
export const UNIDADE_ROTULO = {
  un: "unidade", g: "grama", kg: "quilograma", ml: "mililitro", l: "litro",
  fatia: "fatia", porcao: "porção", folha: "folha",
};

// Cada unidade pertence a uma DIMENSÃO e tem um fator para a unidade canônica
// dessa dimensão. Só se converte dentro da MESMA dimensão.
//   massa   -> canônica: g   (1 kg = 1000 g)
//   volume  -> canônica: ml  (1 l  = 1000 ml)
//   discreta-> cada unidade é sua própria dimensão (un, fatia, ...)
const DIMENSAO = {
  g:  { dim: "massa",  fator: 1 },
  kg: { dim: "massa",  fator: 1000 },
  ml: { dim: "volume", fator: 1 },
  l:  { dim: "volume", fator: 1000 },
  un:     { dim: "un",     fator: 1 },
  fatia:  { dim: "fatia",  fator: 1 },
  porcao: { dim: "porcao", fator: 1 },
  folha:  { dim: "folha",  fator: 1 },
};

/** @param {string} u @returns {boolean} */
export function unidadeValida(u) {
  return Object.prototype.hasOwnProperty.call(DIMENSAO, u);
}

/**
 * Duas unidades são compatíveis se estão na mesma dimensão (massa com massa,
 * volume com volume, 'un' com 'un'...).
 * @param {string} de @param {string} para @returns {boolean}
 */
export function unidadesCompativeis(de, para) {
  return unidadeValida(de) && unidadeValida(para) && DIMENSAO[de].dim === DIMENSAO[para].dim;
}

/**
 * Converte uma quantidade da unidade `de` para a unidade `para`.
 * Lança Error se as unidades forem incompatíveis (ex: g -> ml).
 * @param {number} qtd @param {string} de @param {string} para @returns {number}
 */
export function converterQuantidade(qtd, de, para) {
  const n = Number(qtd);
  if (!Number.isFinite(n)) throw new Error("Quantidade inválida.");
  if (de === para) return n;
  if (!unidadesCompativeis(de, para)) {
    throw new Error(`Unidades incompatíveis: ${de} e ${para}.`);
  }
  // qtd -> canônica -> unidade alvo
  return (n * DIMENSAO[de].fator) / DIMENSAO[para].fator;
}

/**
 * Custo por unidade-base de um insumo.
 *   custo_unitario = preco_compra / quantidade_da_embalagem * fator_correcao
 * Ex.: R$ 47,52 / 24 un = R$ 1,98/un.  R$ 120,00 / 4 kg = R$ 30,00/kg.
 * Devolve null quando não há dados suficientes (não inventa custo).
 * @param {{precoCompra?: number|null, quantidadeEmbalagem?: number|null, fatorCorrecao?: number|null}} p
 * @returns {number|null}
 */
export function custoUnitario({ precoCompra, quantidadeEmbalagem, fatorCorrecao = 1 }) {
  // Ausência de dado (null/undefined/"") não é "custo zero" — é "sem custo".
  if (precoCompra === null || precoCompra === undefined || precoCompra === "") return null;
  if (quantidadeEmbalagem === null || quantidadeEmbalagem === undefined || quantidadeEmbalagem === "") return null;
  const preco = Number(precoCompra);
  const qtd = Number(quantidadeEmbalagem);
  const fc = Number(fatorCorrecao);
  if (!Number.isFinite(preco) || !Number.isFinite(qtd) || qtd <= 0) return null;
  const fator = Number.isFinite(fc) && fc > 0 ? fc : 1;
  return (preco / qtd) * fator;
}

/**
 * Custo aplicado de UM componente da ficha.
 *   converte a quantidade usada para a unidade-base do insumo e multiplica
 *   pelo custo por unidade-base.
 * Ex.: frango R$ 30/kg, usa 76 g -> 0,076 kg -> R$ 2,28.
 * @param {{custoUnitarioBase: number, quantidade: number, unidadeUso: string, unidadeBase: string}} p
 * @returns {number}
 */
export function custoComponente({ custoUnitarioBase, quantidade, unidadeUso, unidadeBase }) {
  const qtdNaBase = converterQuantidade(quantidade, unidadeUso, unidadeBase);
  return qtdNaBase * Number(custoUnitarioBase || 0);
}

/**
 * Custo total do produto = soma dos custos aplicados dos componentes ATIVOS.
 * Cada componente: { custo_total } já calculado, ou o suficiente para calcular.
 * @param {Array<{custoTotal: number, ativo?: boolean}>} componentes
 * @returns {number}
 */
export function custoProduto(componentes) {
  return (componentes ?? [])
    .filter((c) => c.ativo !== false)
    .reduce((s, c) => s + Number(c.custoTotal || 0), 0);
}

/**
 * CMV percentual = custo / preço * 100. Null se não há preço válido (>0).
 * @param {number} custo @param {number} preco @returns {number|null}
 */
export function cmvPct(custo, preco) {
  const p = Number(preco);
  if (!Number.isFinite(p) || p <= 0) return null;
  return (Number(custo || 0) / p) * 100;
}

/**
 * Margem bruta em reais e percentual.
 * @param {number} custo @param {number} preco
 * @returns {{reais: number|null, pct: number|null}}
 */
export function margem(custo, preco) {
  const p = Number(preco);
  if (!Number.isFinite(p) || p <= 0) return { reais: null, pct: null };
  const reais = p - Number(custo || 0);
  return { reais, pct: (reais / p) * 100 };
}

/**
 * Variação percentual entre dois custos unitários (para o histórico).
 * @param {number|null} anterior @param {number|null} novo @returns {number|null}
 */
export function variacaoPct(anterior, novo) {
  const a = Number(anterior);
  const n = Number(novo);
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(n)) return null;
  return ((n - a) / a) * 100;
}

/**
 * Status da ficha de um produto, a partir dos seus componentes.
 * Nunca apresenta um CMV "falso": se há insumo sem custo, o produto é marcado
 * como ficha incompleta e o CMV deve ser suprimido na exibição.
 * @param {{componentes: Array<{custoUnitarioBase: number|null, insumoAtivo?: boolean}>, temPreco?: boolean}} p
 * @returns {{chave: string, label: string, ok: boolean}}
 */
export function statusFicha({ componentes, temPreco = true }) {
  const lista = componentes ?? [];
  if (!lista.length) return { chave: "sem_componentes", label: "Sem componentes", ok: false };
  const semCusto = lista.some((c) => c.custoUnitarioBase == null || Number(c.custoUnitarioBase) <= 0);
  if (semCusto) return { chave: "insumo_sem_custo", label: "Insumo sem custo", ok: false };
  const inativo = lista.some((c) => c.insumoAtivo === false);
  if (inativo) return { chave: "insumo_inativo", label: "Possui insumo inativo", ok: false };
  if (!temPreco) return { chave: "sem_preco", label: "Sem preço de venda", ok: false };
  return { chave: "completa", label: "Completa", ok: true };
}

// ---------------------------------------------------------------------------
// VALIDAÇÕES PURAS (usadas pelo service; devolvem mensagem pt-BR ou null)
// ---------------------------------------------------------------------------

/**
 * Valida os dados de compra de um insumo. Devolve a 1ª mensagem de erro ou null.
 * @param {{preco?: unknown, quantidadeEmbalagem?: unknown, unidadeBase?: unknown, permitirPrecoZero?: boolean}} p
 * @returns {string|null}
 */
export function validarCompraInsumo({ preco, quantidadeEmbalagem, unidadeBase, permitirPrecoZero = true }) {
  if (preco !== undefined && preco !== null && preco !== "") {
    const n = Number(preco);
    if (!Number.isFinite(n)) return "Preço inválido.";
    if (n < 0) return "O preço não pode ser negativo.";
    if (n === 0 && !permitirPrecoZero) return "O preço não pode ser zero.";
  }
  if (quantidadeEmbalagem !== undefined && quantidadeEmbalagem !== null && quantidadeEmbalagem !== "") {
    const q = Number(quantidadeEmbalagem);
    if (!Number.isFinite(q)) return "Quantidade da embalagem inválida.";
    if (q <= 0) return "A quantidade da embalagem deve ser maior que zero.";
  }
  if (unidadeBase !== undefined && !unidadeValida(String(unidadeBase))) {
    return "Unidade-base inválida.";
  }
  return null;
}

/**
 * Valida uma linha de ficha (quantidade usada + unidade compatível com o insumo).
 * @param {{quantidade?: unknown, unidadeUso?: string, unidadeBase?: string}} p
 * @returns {string|null}
 */
export function validarComponenteFicha({ quantidade, unidadeUso, unidadeBase }) {
  const q = Number(quantidade);
  if (!Number.isFinite(q)) return "Quantidade utilizada inválida.";
  if (q <= 0) return "A quantidade utilizada deve ser maior que zero.";
  if (!unidadeValida(unidadeUso)) return "Unidade utilizada inválida.";
  if (!unidadesCompativeis(unidadeUso, unidadeBase)) {
    return `Unidade "${unidadeUso}" é incompatível com a unidade do insumo ("${unidadeBase}").`;
  }
  return null;
}
