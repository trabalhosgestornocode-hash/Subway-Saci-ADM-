// Regras de conciliação — funções PURAS (sem I/O), testáveis sem banco.
// Mesmo espírito de bonificacaoMensal.calc.js: a decisão fica isolada da
// escrita, para poder testar a regra sozinha.
import { norm } from "./parserFoodDelivery.parser.js";
import { OPERACAO, rotuloOperacao } from "./parserFoodDelivery.operacao.js";
import { CLASSIFICACAO_CANCELAMENTO } from "./parserFoodDelivery.classificacao.js";

export const STATUS_CONCILIACAO = {
  INCLUIDO: "incluido",             // taxa válida (entregue/finalizado ou qualquer situação não-cancelada)
  EXCLUIDO: "excluido",             // cancelado E não recebe taxa (motor automático ou override manual) -> taxa descartada
  CANCELADO_COM_TAXA: "cancelado_com_taxa", // cancelado mas recebe taxa ou está em revisão -> taxa continua válida
};

/**
 * Traduz o resultado do motor de classificação automática
 * (parserFoodDelivery.classificacao.js) pro status de conciliação
 * financeira. REVISAR mantém a taxa por padrão — mesmo espírito do
 * comportamento antigo ("cancelado sem código informado mantém a taxa") —
 * só fica destacado como pendente na UI até alguém confirmar/reverter.
 * @param {string} classificacaoCancelamento um de CLASSIFICACAO_CANCELAMENTO
 * @returns {string} um de STATUS_CONCILIACAO
 */
export function resolverStatusConciliacao(classificacaoCancelamento) {
  return classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA
    ? STATUS_CONCILIACAO.EXCLUIDO
    : STATUS_CONCILIACAO.CANCELADO_COM_TAXA;
}

// Catálogo deliberadamente fechado: evita transformar qualquer texto parecido
// em cancelamento, mas aceita as variantes reais mais comuns dos relatórios.
const STATUS_CANCELADOS = new Set([
  "cancelado", "cancelada", "cancelado pelo restaurante",
  "cancelado pelo cliente", "cancelado pelo entregador",
]);
export const ehCancelado = (situacao) => STATUS_CANCELADOS.has(norm(situacao));
/**
 * Pedido sem nome de entregador não entra em NADA da conciliação (item novo
 * do pedido) — não é o `classificarPedido` que decide isso: é filtrado uma
 * camada acima, ANTES da conciliação (parserFoodDelivery.service.js, mesmo
 * estágio do pipeline que remove pedidos de outra operação). Por isso esta
 * função só existe aqui como o critério único e reutilizável — quem chama
 * `classificarPedido` já garante que só chega pedido com entregador.
 */
export const temEntregador = (entregador) => typeof entregador === "string" && entregador.trim() !== "";
/** Chave de agregação segura: não tenta aproximar nomes diferentes, só remove variações de digitação. */
export const chaveEntregador = (entregador) => norm(entregador).replace(/\s+/g, " ");
const nomeExibicaoEntregador = (entregador) => String(entregador).trim().replace(/\s+/g, " ");

/**
 * A ÚNICA regra de negócio da CONCILIAÇÃO em si (item 3 do pedido) — já
 * assume que o pedido passou pelo filtro de operação + entregador:
 *   - não cancelado                          -> incluído (taxa entra normalmente)
 *   - cancelado E código está na lista        -> excluído (taxa descartada)
 *   - cancelado E código NÃO está na lista    -> cancelado_com_taxa (taxa permanece válida)
 * Nunca infere pela sequência logística — só a lista explícita decide.
 * @param {{numeroPedido: string, situacao: string|null}} pedido
 * @param {Set<string>} codigosSemTaxa
 * @returns {string} um de STATUS_CONCILIACAO
 */
export function classificarPedido(pedido, codigosSemTaxa) {
  if (!ehCancelado(pedido.situacao)) return STATUS_CONCILIACAO.INCLUIDO;
  return codigosSemTaxa.has(pedido.numeroPedido) ? STATUS_CONCILIACAO.EXCLUIDO : STATUS_CONCILIACAO.CANCELADO_COM_TAXA;
}

/**
 * @param {Array<{numeroPedido:string, situacao:string|null, taxaEntregador:number|null, statusConciliacao:string,
 *   classificacaoCancelamento?:string|null}>} pedidos já classificados
 */
export function resumoConciliacao(pedidos) {
  let entregues = 0, cancelados = 0, canceladosComTaxa = 0, canceladosSemTaxa = 0;
  let canceladosRecebemTaxa = 0, canceladosNaoRecebemTaxa = 0, canceladosRevisao = 0;
  let taxasBrutas = 0, taxasDescartadas = 0;
  for (const p of pedidos) {
    const taxa = p.taxaEntregador || 0;
    taxasBrutas += taxa;
    if (ehCancelado(p.situacao)) {
      cancelados++;
      if (p.statusConciliacao === STATUS_CONCILIACAO.EXCLUIDO) { canceladosSemTaxa++; taxasDescartadas += taxa; }
      else canceladosComTaxa++;
      // Contadores da ANÁLISE automática — só contam pedidos que já
      // passaram pelo motor (importações antigas ficam com o campo nulo e
      // simplesmente não entram aqui, sem quebrar o resumo).
      if (p.classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA) canceladosRecebemTaxa++;
      else if (p.classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA) canceladosNaoRecebemTaxa++;
      else if (p.classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.REVISAR) canceladosRevisao++;
    } else {
      entregues++;
    }
  }
  const taxasValidas = taxasBrutas - taxasDescartadas;
  return {
    totalPedidos: pedidos.length, entregues, cancelados, canceladosComTaxa, canceladosSemTaxa,
    canceladosRecebemTaxa, canceladosNaoRecebemTaxa, canceladosRevisao,
    taxasBrutas: arredondar(taxasBrutas), taxasDescartadas: arredondar(taxasDescartadas), taxasValidas: arredondar(taxasValidas),
  };
}

/**
 * Agrupa os pedidos já classificados por entregador (item 6 do pedido).
 * Pedido sem nome de entregador não entra aqui — não existe entregador pra
 * atribuir a taxa, então não faz sentido aparecer no ranking/taxas dos
 * entregadores (esses pedidos continuam contados no resumo geral da
 * conciliação, só não aparecem AQUI). A ordenação fica a cargo de quem
 * chama (frontend oferece 3 critérios).
 */
export function agruparPorEntregador(pedidos) {
  const porNome = new Map();
  for (const p of pedidos) {
    if (!temEntregador(p.entregador)) continue;
    const chave = chaveEntregador(p.entregador);
    if (!porNome.has(chave)) {
      porNome.set(chave, { entregador: nomeExibicaoEntregador(p.entregador), totalPedidos: 0, entregues: 0, canceladosComTaxa: 0, canceladosSemTaxa: 0, canceladosRevisao: 0, taxasValidas: 0 });
    }
    const g = porNome.get(chave);
    g.totalPedidos++;
    const taxa = p.taxaEntregador || 0;
    if (ehCancelado(p.situacao)) {
      if (p.statusConciliacao === STATUS_CONCILIACAO.EXCLUIDO) g.canceladosSemTaxa++;
      else { g.canceladosComTaxa++; g.taxasValidas += taxa; }
      if (p.classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.REVISAR) g.canceladosRevisao++;
    } else {
      g.entregues++;
      g.taxasValidas += taxa;
    }
  }
  return [...porNome.values()].map((g) => ({ ...g, taxasValidas: arredondar(g.taxasValidas) }));
}

/**
 * Valida um código digitado pelo usuário contra os pedidos da prévia (item 2).
 * O mapa recebido é o de TODOS os pedidos do arquivo (Subway + outras
 * operações) — só assim dá pra diferenciar "não encontrado" de "encontrado,
 * mas é de outra operação" (item novo: cancelamento sem taxa só vale para
 * pedidos já classificados como Subway).
 * @param {string} codigo
 * @param {Map<string, {situacao: string|null, operacao?: string}>} pedidosPorNumero
 */
export function validarCodigo(codigo, pedidosPorNumero) {
  const chave = String(codigo).trim();
  const pedido = pedidosPorNumero.get(chave);
  if (!pedido) return { codigo: chave, encontrado: false, situacao: null, cancelado: false, operacao: null, alerta: "Pedido não encontrado" };

  if (pedido.operacao && pedido.operacao !== OPERACAO.SUBWAY) {
    return {
      codigo: chave, encontrado: true, situacao: pedido.situacao, cancelado: false, operacao: pedido.operacao,
      alerta: pedido.operacao === OPERACAO.REVISAO_NECESSARIA
        ? "Este pedido está com a operação indefinida (revisão necessária) — confira antes de usar este código."
        : `Este pedido foi identificado como pertencente a outra operação (${rotuloOperacao(pedido.operacao)}) e não faz parte desta conciliação.`,
    };
  }
  if (!temEntregador(pedido.entregador)) {
    return {
      codigo: chave, encontrado: true, situacao: pedido.situacao, cancelado: ehCancelado(pedido.situacao), operacao: pedido.operacao ?? OPERACAO.SUBWAY,
      alerta: "Este pedido não tem entregador atribuído — já fica de fora da conciliação automaticamente, não precisa informar o código.",
    };
  }

  const cancelado = ehCancelado(pedido.situacao);
  return {
    codigo: chave, encontrado: true, situacao: pedido.situacao, cancelado, operacao: pedido.operacao ?? OPERACAO.SUBWAY,
    alerta: cancelado ? null : "Pedido encontrado, mas a situação não é \"Cancelado\" — a taxa não será descartada automaticamente.",
  };
}

/** Divide texto colado (vírgula, espaço ou quebra de linha) numa lista de códigos únicos. */
export function extrairCodigos(texto) {
  return [...new Set(String(texto || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

const arredondar = (n) => Math.round(n * 100) / 100;
