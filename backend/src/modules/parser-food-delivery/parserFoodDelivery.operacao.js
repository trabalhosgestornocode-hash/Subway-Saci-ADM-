// Identificação da OPERAÇÃO de cada pedido — camada centralizada e única
// responsável por decidir se um pedido é da Subway Saci, de outra operação
// (ex.: Açaí no Grau) ou precisa de revisão manual.
//
// Por que existe: o relatório de food delivery mistura pedidos de mais de
// uma operação no mesmo arquivo (mesma conta de entrega). Sem filtrar isso
// ANTES da conciliação, os valores financeiros e o desempenho dos
// entregadores ficariam contaminados com pedidos que não são da Subway.
//
// Extensibilidade: uma operação nova = uma entrada nova em
// `OPERACOES_CONHECIDAS`, com seus próprios termos. `classificarOperacao`
// não muda — é genérico para N operações, não só duas.
import { norm } from "./parserFoodDelivery.parser.js";

export const OPERACAO = {
  SUBWAY: "subway",
  ACAI_NO_GRAU: "acai_no_grau",
  // Termos de mais de uma operação no mesmo pedido, ou nenhuma descrição
  // para analisar — nunca vira exclusão automática, sempre revisão humana.
  REVISAO_NECESSARIA: "revisao_necessaria",
};

/**
 * Catálogo de operações conhecidas. `principal: true` marca a operação "de
 * casa" (Subway) — é o default de quem não bate com nenhuma operação
 * secundária. As demais são carve-outs: só saem da Subway quando um termo
 * delas é encontrado.
 *
 * Termos vêm do relatório real (auditoria: "Monte seu Açaí & Cremes",
 * "Açaí Premium", "Copo de açaí e creme personalizado", "Açaí Zero",
 * "Açaí Tradicional") + exemplos dados no pedido (Pote, Paleta, Brownie).
 * `norm()` já tira acento/caixa, então "acai" cobre açaí/açai/acaí/Açaí.
 */
const OPERACOES_CONHECIDAS = [
  {
    id: OPERACAO.SUBWAY, nome: "Subway Saci", principal: true,
    termos: ["subway", "sub", "subs", "salada", "saladas", "footlong", "sanduiche", "sanduba"],
  },
  {
    id: OPERACAO.ACAI_NO_GRAU, nome: "Açaí no Grau", principal: false,
    // Só termos distintivos podem excluir automaticamente da operação
    // principal. Pote, paleta e brownie são produtos genéricos e precisam de
    // contexto (ou de revisão), pois também podem existir no cardápio Subway.
    termos: [
      "acai",
      // Combinação observada no relatório real: é específica o bastante para
      // identificar a operação, ao contrário de "paleta" isoladamente.
      "paleta morango com leite condesado", "paleta morango com leite condensado",
    ],
  },
];
const OPERACAO_PRINCIPAL = OPERACOES_CONHECIDAS.find((o) => o.principal);
const TERMOS_AMBIGUOS_ACAI = ["pote", "paleta", "brownie"];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Casa `termo` como palavra inteira (evita "sub" pegar dentro de "substituto"). */
function contemTermo(textoNormalizado, termo) {
  const padrao = escapeRegExp(termo).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${padrao}\\b`).test(textoNormalizado);
}

/**
 * Classifica UM pedido pela operação, a partir do campo "Detalhes do
 * pedido" (item central do pedido — é o único campo confiável de
 * composição/produtos; nunca varre Observações ou outros campos livres, que
 * geram falso positivo por palavra solta).
 *
 * Regras (nessa ordem):
 *   1. sem descrição pra analisar            -> revisão necessária
 *   2. nenhum termo de operação secundária    -> Subway (default seguro —
 *      Subway é a operação "de casa"; só sai daqui com evidência positiva
 *      de outra operação, nunca por ausência de prova)
 *   3. termos de EXATAMENTE uma secundária, sem termo da principal junto
 *                                              -> aquela operação secundária
 *   4. termos de mais de uma operação juntos (ou secundária + principal)
 *                                              -> revisão necessária (dúvida
 *      real — nunca excluído automaticamente, item explícito do pedido)
 *
 * @param {{detalhesPedido?: string|null}} pedido
 * @returns {{operacao: string, motivo: string|null, termosEncontrados: string[]}}
 */
export function classificarOperacao(pedido) {
  const bruto = pedido?.detalhesPedido;
  if (bruto == null || String(bruto).trim() === "") {
    return { operacao: OPERACAO.REVISAO_NECESSARIA, motivo: "Sem descrição de produtos (\"Detalhes do pedido\") para identificar a operação.", termosEncontrados: [] };
  }

  const texto = norm(bruto);
  const encontrados = OPERACOES_CONHECIDAS
    .map((op) => ({ op, termos: op.termos.filter((t) => contemTermo(texto, t)) }))
    .filter((r) => r.termos.length > 0);

  const secundarias = encontrados.filter((r) => !r.op.principal);

  if (secundarias.length === 0) {
    const principal = encontrados.find((r) => r.op.principal);
    const ambiguos = TERMOS_AMBIGUOS_ACAI.filter((t) => contemTermo(texto, t));
    if (!principal && ambiguos.length) {
      return {
        operacao: OPERACAO.REVISAO_NECESSARIA,
        motivo: `Encontrei termo(s) ambíguo(s) (${ambiguos.join(", ")}) sem identificador claro da operação. Confira manualmente.`,
        termosEncontrados: ambiguos,
      };
    }
    return { operacao: OPERACAO_PRINCIPAL.id, motivo: null, termosEncontrados: principal?.termos ?? [] };
  }
  if (secundarias.length === 1 && encontrados.length === 1) {
    const { op, termos } = secundarias[0];
    return { operacao: op.id, motivo: `Produto(s) identificado(s) como ${op.nome}: ${termos.join(", ")}.`, termosEncontrados: termos };
  }

  // Mais de uma operação encontrada junto (secundária + principal, ou duas
  // secundárias) — dúvida real, item do pedido: nunca excluir automático.
  const resumo = encontrados.map((r) => `${r.op.nome} (${r.termos.join(", ")})`).join(" · ");
  return {
    operacao: OPERACAO.REVISAO_NECESSARIA,
    motivo: `Encontrei termos de mais de uma operação no mesmo pedido: ${resumo}. Confira manualmente.`,
    termosEncontrados: encontrados.flatMap((r) => r.termos),
  };
}

/** Rótulo em pt-BR de uma operação — usado nas telas de auditoria. */
export function rotuloOperacao(id) {
  return OPERACOES_CONHECIDAS.find((o) => o.id === id)?.nome ?? (id === OPERACAO.REVISAO_NECESSARIA ? "Revisão necessária" : id);
}
