// Este arquivo tem DOIS motores distintos — a confusão entre os dois foi
// exatamente o erro de interpretação corrigido nesta revisão. Não são o
// mesmo conceito e não se misturam:
//
// 1) avaliarElegibilidadeBonificacao — Nota iFood, REV e Pesquisas são
//    CRITÉRIOS OBRIGATÓRIOS de elegibilidade da bonificação MENSAL inteira
//    (não indicadores de bônus parcial, como os demais, avaliados por faixa
//    em bonificacaoMensal.metas.js). Se qualquer um dos 3 não é atingido, a
//    bonificação do MÊS INTEIRO (soma dos outros indicadores) some por
//    completo — nunca um cálculo proporcional ("punição integral").
//
// 2) avaliarSuperRestaurante — é SÓ o agrupamento visual que a própria
//    operação já usa na planilha ("Ifood: Super Restaurante" = Avaliação +
//    Cancelamentos + Pedidos com Chamado). NÃO é um portão de elegibilidade,
//    não tem pontuação própria, não faz média entre os três indicadores e
//    não inventa percentual geral — devolve só a contagem de quantos dos 3
//    estão dentro da própria meta e, se algum não estiver, o motivo (pra
//    exibição discreta, nunca "punição"). Cancelamentos e Pedidos com
//    Chamado continuam sem contribuir R$ (faixas com bonus=null desde
//    sempre) e continuam FORA da decisão de elegibilidade do item 1 — isso
//    não mudou aqui, só a forma de agrupar visualmente os três.
//
// Puro, sem I/O, mesmo espírito de bonificacaoMensal.metas.js: o service
// resolve valor/mínimo de cada critério (mínimo vem de bonificacao_metas —
// mesma fonte de sempre, sem duplicar dado) e passa pra cá; o frontend só
// mostra o resultado.
//
// avaliarElegibilidadeBonificacao também é o ponto de entrada natural pra
// uma futura tool do Agente Crescer ("consultar_elegibilidade_bonificacao"):
// já devolve dado estruturado (status + critério a critério + motivos),
// nunca texto pronto de tela — quem decide como apresentar é quem chama.

/** Estados da elegibilidade da bonificação mensal. */
export const STATUS_ELEGIBILIDADE_BONIFICACAO = {
  ELEGIVEL: "elegivel",
  EM_ACOMPANHAMENTO: "em_acompanhamento",
  NAO_ELEGIVEL: "nao_elegivel",
};

const CRITERIOS_INFO = {
  nota_ifood: { label: "Nota iFood", motivo: "Nota iFood abaixo do mínimo estabelecido para elegibilidade da bonificação." },
  rev: { label: "REV", motivo: "REV abaixo do parâmetro mínimo estabelecido para o período." },
  pesquisas: { label: "Pesquisas", motivo: "Volume mínimo de pesquisas mensais ainda não foi alcançado." },
};

/**
 * Avalia UM critério isolado.
 *   `minimo == null`  -> sem meta cadastrada pra esta unidade ainda. Não é
 *     reprovação (é ausência de configuração) — o critério fica de fora da
 *     decisão até alguém cadastrar o mínimo dele.
 *   `valor == null` (com meta cadastrada) -> ainda não informado no período.
 *   Limite é INCLUSIVO nos dois sentidos possíveis — "o valor exato do
 *   limite deve ser aceito" (cenários de borda dos testes).
 *   `direcao: "min"` (padrão) -> aprova quando valor >= mínimo (ex.: nota,
 *   REV, pesquisas — quanto maior, melhor). `direcao: "max"` -> aprova
 *   quando valor <= limite (ex.: cancelamentos, pedidos com chamado —
 *   quanto menor, melhor).
 * @param {{valor:number|null, minimo:number|null, direcao?:"min"|"max"}} p
 */
function avaliarCriterio({ valor, minimo, direcao = "min" }) {
  if (minimo == null) return { valor: valor ?? null, minimo: null, temMeta: false, atingido: null };
  if (valor == null) return { valor: null, minimo, temMeta: true, atingido: null };
  const atingido = direcao === "max" ? Number(valor) <= Number(minimo) : Number(valor) >= Number(minimo);
  return { valor: Number(valor), minimo: Number(minimo), temMeta: true, atingido };
}

/**
 * @param {{
 *   notaIfood: {valor:number|null, minimo:number|null},
 *   rev: {valor:number|null, minimo:number|null},
 *   pesquisas: {valor:number|null, minimo:number|null},
 *   mesFechado: boolean,
 * }} p
 * @returns {{
 *   status: string,
 *   criterios: {nota_ifood: object, rev: object, pesquisas: object},
 *   motivosInelegibilidade: string[],
 * }}
 */
export function avaliarElegibilidadeBonificacao({ notaIfood, rev, pesquisas, mesFechado }) {
  const criterios = {
    nota_ifood: avaliarCriterio(notaIfood),
    rev: avaliarCriterio(rev),
    pesquisas: avaliarCriterio(pesquisas),
  };

  // Só entram na decisão os critérios que TÊM meta cadastrada — uma unidade
  // sem a meta de REV configurada ainda não pode ser "reprovada" por REV, só
  // não tem esse critério avaliado.
  const avaliaveis = Object.entries(criterios).filter(([, c]) => c.temMeta);
  const falharam = avaliaveis.filter(([, c]) => c.atingido === false);
  const semDado = avaliaveis.filter(([, c]) => c.atingido === null);

  let status;
  if (!avaliaveis.length) {
    // Nenhum dos 3 critérios tem meta cadastrada pra esta unidade — nada
    // pra avaliar ainda (gap de configuração, não desempenho).
    status = STATUS_ELEGIBILIDADE_BONIFICACAO.EM_ACOMPANHAMENTO;
  } else if (falharam.length === 0 && semDado.length === 0) {
    status = STATUS_ELEGIBILIDADE_BONIFICACAO.ELEGIVEL;
  } else if (mesFechado) {
    // Competência encerrada (mesmo controle de fechamento que o resto do
    // módulo já usa — obterMes()#mesFechado): falha confirmada OU dado
    // nunca informado — nos dois casos o critério não foi comprovadamente
    // atingido, e não há mais chance de o mês evoluir.
    status = STATUS_ELEGIBILIDADE_BONIFICACAO.NAO_ELEGIVEL;
  } else {
    // Mês ainda aberto: nunca marca como definitivamente não elegível
    // enquanto o indicador ainda pode ser atingido.
    status = STATUS_ELEGIBILIDADE_BONIFICACAO.EM_ACOMPANHAMENTO;
  }

  const motivosInelegibilidade = status === STATUS_ELEGIBILIDADE_BONIFICACAO.NAO_ELEGIVEL
    ? [...falharam, ...semDado].map(([chave]) => CRITERIOS_INFO[chave].motivo)
    : [];

  return { status, criterios, motivosInelegibilidade };
}

/** Rótulo/ícone de cada critério de elegibilidade — usado pelo frontend e por uma futura tool do Agente. */
export const LABEL_CRITERIO = Object.fromEntries(Object.entries(CRITERIOS_INFO).map(([k, v]) => [k, v.label]));

// ---------------------------------------------------------------------------
// SUPER RESTAURANTE — agrupamento "Ifood: Super Restaurante" da planilha
// (Avaliação + Cancelamentos + Pedidos com Chamado). Apenas contagem +
// pontos de atenção, nunca pontuação/média/percentual próprio.
// ---------------------------------------------------------------------------
const CRITERIOS_SUPER_RESTAURANTE_INFO = {
  avaliacao_ifood: { label: "Avaliação iFood", direcao: "min", motivo: (min) => `Avaliação iFood abaixo do mínimo de ${min}.` },
  cancelamentos: { label: "Cancelamentos", direcao: "max", motivo: (max) => `Cancelamentos acima do limite de ${max}%.` },
  pedidos_chamado: { label: "Pedidos com Chamado", direcao: "max", motivo: (max) => `Pedidos com Chamado acima do limite de ${max}%.` },
};

/**
 * @param {{
 *   avaliacaoIfood: {valor:number|null, minimo:number|null},
 *   cancelamentos: {valor:number|null, minimo:number|null},
 *   pedidosChamado: {valor:number|null, minimo:number|null},
 * }} p
 * @returns {{
 *   criterios: {avaliacao_ifood: object, cancelamentos: object, pedidos_chamado: object},
 *   totalComMeta: number,
 *   dentroDaMeta: number,
 *   pontosDeAtencao: string[],
 * }}
 */
export function avaliarSuperRestaurante({ avaliacaoIfood, cancelamentos, pedidosChamado }) {
  const entradas = { avaliacao_ifood: avaliacaoIfood, cancelamentos, pedidos_chamado: pedidosChamado };
  const criterios = {};
  for (const [chave, info] of Object.entries(CRITERIOS_SUPER_RESTAURANTE_INFO)) {
    criterios[chave] = avaliarCriterio({ ...entradas[chave], direcao: info.direcao });
  }
  const comMeta = Object.entries(criterios).filter(([, c]) => c.temMeta);
  const dentroDaMeta = comMeta.filter(([, c]) => c.atingido === true).length;
  const pontosDeAtencao = comMeta
    .filter(([, c]) => c.atingido === false)
    .map(([chave, c]) => CRITERIOS_SUPER_RESTAURANTE_INFO[chave].motivo(c.minimo));

  return { criterios, totalComMeta: comMeta.length, dentroDaMeta, pontosDeAtencao };
}

/** Rótulo de cada indicador do Super Restaurante — usado pelo frontend. */
export const LABEL_CRITERIO_SUPER_RESTAURANTE = Object.fromEntries(
  Object.entries(CRITERIOS_SUPER_RESTAURANTE_INFO).map(([k, v]) => [k, v.label]),
);
