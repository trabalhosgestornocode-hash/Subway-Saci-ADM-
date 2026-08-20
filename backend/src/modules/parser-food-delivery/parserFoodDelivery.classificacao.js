// Motor de classificação AUTOMÁTICA dos pedidos cancelados — decide se um
// cancelamento RECEBE TAXA, NÃO RECEBE TAXA ou precisa de REVISÃO humana.
// Funções PURAS (sem I/O), mesmo espírito de parserFoodDelivery.calc.js —
// testável sem banco, sem depender de horário do relógio real.
//
// Regra de ouro do pedido original: a decisão vem SEMPRE da CRONOLOGIA DE
// EVENTOS operacionais do pedido (despachado/aceito/coletado/chegada), nunca
// só do tempo decorrido, nunca de "Aceito" como sinônimo de "saiu pra
// entrega" — só "Coletado" significa isso no nosso processo. Razão e
// justificativa do cancelamento nunca decidem sozinhas: só compõem o texto
// explicativo (`motivo`) como contexto complementar.
//
// Pedido sem entregador atribuído NUNCA chega aqui — é filtrado uma camada
// acima (parserFoodDelivery.service.js#ehElegivelConciliacao), antes até de
// entrar na conciliação. Este motor só roda para pedidos Subway, COM
// entregador, com situação "Cancelado".

export const CLASSIFICACAO_CANCELAMENTO = {
  RECEBE_TAXA: "recebe_taxa",
  NAO_RECEBE_TAXA: "nao_recebe_taxa",
  REVISAR: "revisar",
};

export const NIVEL_CONFIANCA = {
  MUITO_ALTA: "muito_alta",
  ALTA: "alta",
  INCONCLUSIVA: "inconclusiva",
};

const { RECEBE_TAXA, NAO_RECEBE_TAXA, REVISAR } = CLASSIFICACAO_CANCELAMENTO;
const { MUITO_ALTA, ALTA, INCONCLUSIVA } = NIVEL_CONFIANCA;

const paraMs = (iso) => (iso ? new Date(iso).getTime() : null);
/** true só quando os dois existem E `antes` é estritamente anterior a `depois`. */
const antesDe = (antes, depois) => {
  const a = paraMs(antes), d = paraMs(depois);
  return a != null && d != null && !Number.isNaN(a) && !Number.isNaN(d) && a < d;
};
/** true quando os dois existem e o primeiro não acontece depois do segundo. */
const antesOuIgual = (antes, depois) => {
  const a = paraMs(antes), d = paraMs(depois);
  return a != null && d != null && !Number.isNaN(a) && !Number.isNaN(d) && a <= d;
};
const depoisDe = (depois, antes) => antesDe(antes, depois);
const tem = (v) => v != null && String(v).trim() !== "";

/** "38min57s" a partir de dois ISOs — só para o texto explicativo, nunca para decidir. */
function duracaoHumana(iniIso, fimIso) {
  const ini = paraMs(iniIso), fim = paraMs(fimIso);
  if (ini == null || fim == null || Number.isNaN(ini) || Number.isNaN(fim) || fim < ini) return null;
  const totalSeg = Math.round((fim - ini) / 1000);
  const min = Math.floor(totalSeg / 60), seg = totalSeg % 60;
  return min > 0 ? `${min}min${String(seg).padStart(2, "0")}s` : `${seg}s`;
}

/** Contexto complementar (nunca decisivo) — anexado ao `motivo` quando existe justificativa. */
function contexto(pedido) {
  const just = pedido.justificativaCancelamento;
  return tem(just) ? ` Justificativa do cancelamento: "${String(just).trim()}".` : "";
}

/**
 * Classifica UM pedido cancelado. Assume que quem chama já garantiu:
 * situação = Cancelado, operação = Subway, com entregador atribuído.
 * @param {{dataColetado?:string|null, dataChegadaEntrega?:string|null, dataDespachado?:string|null,
 *   dataAceito?:string|null, dataCancelado?:string|null, justificativaCancelamento?:string|null}} pedido
 * @returns {{classificacao: string, motivo: string, nivelConfianca: string, regra: string}}
 */
export function classificarCancelamento(pedido) {
  const { dataColetado, dataChegadaEntrega, dataDespachado, dataAceito, dataCancelado } = pedido;

  // Sem o próprio horário de cancelamento não dá pra comparar cronologia
  // nenhuma — insuficiente por definição.
  if (!tem(dataCancelado)) {
    return {
      classificacao: REVISAR, nivelConfianca: INCONCLUSIVA, regra: "regra_contraditorio",
      motivo: `Este pedido está cancelado, mas o relatório não trouxe o horário do cancelamento — não dá pra comparar com os demais eventos.${contexto(pedido)}`,
    };
  }

  // Qualquer evento operacional posterior ao cancelamento torna a linha
  // contraditória. Não é seguro ignorá-lo e decidir só com os eventos que
  // ficaram antes: o relatório pode estar atrasado ou trazer um estado
  // sobrescrito. Igualdade no segundo é aceita, pois não inverte a ordem.
  const posteriores = [
    ["despacho", dataDespachado], ["aceite", dataAceito],
    ["coleta", dataColetado], ["chegada", dataChegadaEntrega],
  ].filter(([, data]) => tem(data) && depoisDe(data, dataCancelado)).map(([nome]) => nome);
  if (posteriores.length) {
    return {
      classificacao: REVISAR, nivelConfianca: INCONCLUSIVA, regra: "regra_contraditorio",
      motivo: `Há evento(s) posterior(es) ao cancelamento (${posteriores.join(", ")}) — confira manualmente.${contexto(pedido)}`,
    };
  }

  // regra_chegada — evidência mais forte: coletou E chegou ao endereço antes
  // de cancelar. Sempre que a chegada é válida, a coleta também precisa ser
  // (não existe "chegou pra entrega" sem ter coletado antes).
  if (antesOuIgual(dataColetado, dataCancelado) && antesOuIgual(dataChegadaEntrega, dataCancelado) && antesOuIgual(dataColetado, dataChegadaEntrega)) {
    return {
      classificacao: RECEBE_TAXA, nivelConfianca: MUITO_ALTA, regra: "regra_chegada",
      motivo: `Há registro de coleta e de chegada ao endereço antes do cancelamento — o entregador chegou a ir até o cliente.${contexto(pedido)}`,
    };
  }

  // regra_coleta — coletado antes do cancelamento (sem chegada registrada,
  // ou chegada com ordem inconsistente — cai pra regra 5 nesse caso raro).
  if (antesOuIgual(dataColetado, dataCancelado) && (!tem(dataChegadaEntrega) || antesOuIgual(dataColetado, dataChegadaEntrega))) {
    const dur = duracaoHumana(dataColetado, dataCancelado);
    return {
      classificacao: RECEBE_TAXA, nivelConfianca: ALTA, regra: "regra_coleta",
      motivo: `Pedido coletado antes do cancelamento — o entregador já havia iniciado a entrega${dur ? ` (${dur} entre coleta e cancelamento)` : ""}.${contexto(pedido)}`,
    };
  }

  // regra_sem_coleta — foi despachado/aceito mas cancelou ANTES de coletar
  // (ou nunca coletou). Despacho/aceite sozinhos NUNCA contam como "saiu
  // pra entrega" (item explícito do pedido original).
  if ((tem(dataDespachado) || tem(dataAceito)) && !tem(dataColetado)) {
    return {
      classificacao: NAO_RECEBE_TAXA, nivelConfianca: ALTA, regra: "regra_sem_coleta",
      motivo: `O pedido foi atribuído${tem(dataAceito) ? " e aceito" : ""}, mas foi cancelado antes da coleta — o entregador não chegou a sair para a entrega.${contexto(pedido)}`,
    };
  }

  // regra_contraditorio (catch-all) — qualquer combinação que sobrou: datas
  // fora de ordem (cancelamento antes da coleta), coletado presente mas sem
  // conseguir provar que foi antes do cancelamento, ou nenhum evento
  // logístico registrado apesar de ter entregador atribuído. Nunca decide
  // sozinho — item 21/22 do pedido original.
  const motivos = [];
  if (tem(dataColetado) && !antesDe(dataColetado, dataCancelado)) motivos.push("o horário de coleta não é anterior ao do cancelamento");
  if (!tem(dataDespachado) && !tem(dataAceito) && !tem(dataColetado)) motivos.push("não há nenhum evento de despacho, aceite ou coleta registrado, apesar de ter entregador atribuído");
  const detalhe = motivos.length ? ` (${motivos.join("; ")})` : "";
  return {
    classificacao: REVISAR, nivelConfianca: INCONCLUSIVA, regra: "regra_contraditorio",
    motivo: `Os dados deste pedido são insuficientes ou contraditórios para decidir automaticamente${detalhe} — confira manualmente.${contexto(pedido)}`,
  };
}
