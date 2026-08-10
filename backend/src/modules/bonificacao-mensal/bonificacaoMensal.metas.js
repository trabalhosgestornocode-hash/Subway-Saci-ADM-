// Motor de bonificação — FONTE ÚNICA da lógica de faixas/metas da
// Bonificação Mensal. Puro, sem I/O (mesmo espírito de
// dashboard-executivo/dashboardExecutivo.calc.js e insumos.calc.js): o
// service resolve qual meta está vigente e passa pra cá; o frontend só
// mostra o resultado, nunca reimplementa "if (bebidas >= 52) ...".
//
// Regra geral (itens 32-33 das instruções): cada indicador tem faixas
// (tiers). O resultado é sempre a MELHOR faixa atingida — nunca a soma das
// faixas inferiores do mesmo indicador.

/** @typedef {'higher_is_better'|'lower_is_better'} Direcao */
/** @typedef {'limite_minimo'|'limite_maximo'|'intervalo'} TipoFaixa */

/**
 * @typedef {object} Faixa
 * @property {number} ordem
 * @property {TipoFaixa} tipo
 * @property {number|null} valorMin
 * @property {number|null} valorMax
 * @property {number|null} bonus  null = sem valor de bonificação definido (ver item 60); 0 = bônus real de zero reais.
 */

/**
 * @typedef {object} MetaConfig
 * @property {string} indicador
 * @property {Direcao} direcao
 * @property {Faixa[]} faixas
 */

/** Status possíveis do resultado de um indicador frente à meta. */
export const STATUS_METRICA = {
  SEM_DADOS: "sem_dados",           // indicador não foi informado (null) — nunca confundir com 0
  SEM_META: "sem_meta",             // não há meta vigente cadastrada para o período
  META_NAO_ATINGIDA: "meta_nao_atingida",
  DENTRO_DA_META: "dentro_da_meta", // atingiu ao menos a 1ª faixa, mas não a máxima
  META_MAXIMA: "meta_maxima",       // atingiu a melhor faixa possível
};

/** @param {Faixa} f @returns {boolean} true se a faixa tem um valor de bonificação definido. */
export function faixaTemBonus(f) {
  return f?.bonus != null;
}

/** @param {MetaConfig|null|undefined} meta @returns {boolean} */
export function metaTemBonusDefinido(meta) {
  return !!meta?.faixas?.some(faixaTemBonus);
}

function atinge(valor, faixa) {
  if (faixa.tipo === "limite_minimo") return faixa.valorMin != null && valor >= faixa.valorMin;
  if (faixa.tipo === "limite_maximo") return faixa.valorMax != null && valor <= faixa.valorMax;
  if (faixa.tipo === "intervalo") return faixa.valorMin != null && faixa.valorMax != null && valor >= faixa.valorMin && valor <= faixa.valorMax;
  return false;
}

/** Alvo numérico de uma faixa ainda não atingida, na direção do indicador. */
function alvoDaFaixa(faixa, direcao) {
  if (direcao === "higher_is_better") return faixa.valorMin ?? faixa.valorMax ?? null;
  return faixa.valorMax ?? faixa.valorMin ?? null;
}

/**
 * Avalia um indicador contra a meta vigente — o "evaluateBonusMetric" do
 * item 58. Nunca soma faixas do mesmo indicador; sempre a melhor atingida.
 * @param {number|null|undefined} valor
 * @param {MetaConfig|null|undefined} meta
 * @returns {{
 *   status: string, faixaAtual: Faixa|null, bonusAtual: number|null,
 *   proximaFaixa: Faixa|null, faltante: number|null, bonusProximaFaixa: number|null,
 *   faixaMaxima: Faixa|null, bonusMaximo: number|null, temBonusDefinido: boolean,
 * }}
 */
export function evaluateBonusMetric(valor, meta) {
  const vazio = {
    faixaAtual: null, bonusAtual: null, proximaFaixa: null, faltante: null,
    bonusProximaFaixa: null, faixaMaxima: null, bonusMaximo: null,
    temBonusDefinido: metaTemBonusDefinido(meta),
  };

  if (valor == null) return { ...vazio, status: STATUS_METRICA.SEM_DADOS };
  if (!meta?.faixas?.length) return { ...vazio, status: STATUS_METRICA.SEM_META };

  const faixas = [...meta.faixas].sort((a, b) => a.ordem - b.ordem);
  const faixaMaxima = faixas[faixas.length - 1];

  // melhor faixa atingida = a de MAIOR ordem cujo teste passa. Cobre tanto
  // faixas ascendentes normais quanto faixas segmentadas/descendentes
  // (CMV) — o teste é sempre "atinge(valor, faixa)", nunca uma comparação
  // implícita de que uma faixa engloba a anterior.
  let melhor = null;
  for (const f of faixas) if (atinge(valor, f)) melhor = f;

  if (!melhor) {
    const proxima = faixas[0];
    const alvo = alvoDaFaixa(proxima, meta.direcao);
    const faltante = alvo == null ? null : (meta.direcao === "higher_is_better" ? alvo - valor : valor - alvo);
    return {
      ...vazio, status: STATUS_METRICA.META_NAO_ATINGIDA,
      proximaFaixa: proxima, faltante, bonusProximaFaixa: proxima.bonus,
      faixaMaxima, bonusMaximo: faixaMaxima.bonus,
    };
  }

  const idx = faixas.indexOf(melhor);
  const proxima = faixas[idx + 1] || null;
  const alvo = proxima ? alvoDaFaixa(proxima, meta.direcao) : null;
  const faltante = proxima && alvo != null ? (meta.direcao === "higher_is_better" ? alvo - valor : valor - alvo) : null;

  return {
    ...vazio,
    status: proxima ? STATUS_METRICA.DENTRO_DA_META : STATUS_METRICA.META_MAXIMA,
    faixaAtual: melhor, bonusAtual: melhor.bonus,
    proximaFaixa: proxima, faltante, bonusProximaFaixa: proxima?.bonus ?? null,
    faixaMaxima, bonusMaximo: faixaMaxima.bonus,
  };
}

/**
 * Resolve qual versão de uma meta vale para uma data — a mais recente cujo
 * `validFrom` <= data <= (`validUntil` ou infinito). Histórico não muda
 * quando uma meta futura é cadastrada (item 31): cada mês usa a meta que
 * valia NAQUELE mês.
 * @param {Array<{indicador:string, validFrom:string, validUntil:string|null}>} metas já filtradas pelo indicador certo
 * @param {string} dataIso AAAA-MM-DD
 */
export function resolverMetaVigente(metas, dataIso) {
  const candidatas = (metas || []).filter((m) => m.validFrom <= dataIso && (!m.validUntil || m.validUntil >= dataIso));
  if (!candidatas.length) return null;
  return candidatas.reduce((melhor, m) => (!melhor || m.validFrom > melhor.validFrom ? m : melhor), null);
}

/**
 * Bonificação total do período = soma da melhor faixa de CADA indicador que
 * tem valor de bônus definido. Indicadores sem meta/sem dados não entram —
 * nunca como R$ 0 (item 60).
 * @param {Record<string, ReturnType<typeof evaluateBonusMetric>>} resultadosPorIndicador
 */
export function totalBonificacao(resultadosPorIndicador) {
  let atual = 0, maximo = 0, metasAtingidas = 0, metasComDados = 0, metasComRegra = 0;
  for (const r of Object.values(resultadosPorIndicador || {})) {
    if (!r.temBonusDefinido) continue; // sem regra de negócio de valor — não entra na soma nem no total possível
    metasComRegra++;
    if (r.status === STATUS_METRICA.SEM_DADOS || r.status === STATUS_METRICA.SEM_META) continue;
    metasComDados++;
    // "Meta atingida" = a faixa alcançada rende bônus real (> 0). Uma faixa
    //-base com bônus R$ 0 (ex.: 1ª faixa de Pesquisas/REV) entra na soma
    // (que já é 0) mas não conta como meta conquistada.
    if (r.bonusAtual != null) { atual += r.bonusAtual; if (r.bonusAtual > 0) metasAtingidas++; }
    if (r.bonusMaximo != null) maximo += r.bonusMaximo;
  }
  return { atual, maximo, metasAtingidas, metasComDados, metasComRegra };
}
