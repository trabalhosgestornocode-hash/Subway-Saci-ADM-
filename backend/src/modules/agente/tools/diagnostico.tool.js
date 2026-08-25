// Tool "consultar_diagnostico" — expõe ao Claude o diagnóstico JÁ CALCULADO
// pelo motor determinístico (dashboardExecutivo.diagnostico.js#gerarDiagnostico),
// que roda DENTRO de obterMes(). Esta tool nunca recalcula nada: só chama o
// mesmo obterMes() da tool de dashboard e recorta o campo `diagnostico`.
//
// dados -> motor determinístico existente -> diagnóstico -> Claude -> explicação
// (nunca: dados brutos -> Claude inventa diagnóstico)
//
// SEGURANÇA DE TENANT: mesma regra de dashboardExecutivo.tool.js — organizacaoId/
// unidadeId vêm sempre de `contexto`, nunca de `input`.
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as dashboardExecutivoService from "../../dashboard-executivo/dashboardExecutivo.service.js";
import { resolverPeriodo } from "./dashboardExecutivo.tool.js";

export const definicao = {
  name: "consultar_diagnostico",
  description:
    "Obtém o DIAGNÓSTICO já calculado pelo motor determinístico do Dashboard Executivo para um mês: pontos fortes, pontos de atenção, alertas, plano de ação (ações sugeridas com prioridade) e o nível de confiabilidade dos dados do mês. Este diagnóstico já foi calculado pelo Crescer com Delivery — não recalcule nem invente um diagnóstico próprio, apenas explique o que a ferramenta retornou. Use quando o usuário pedir uma análise, avaliação, diagnóstico, recomendações ou plano de ação sobre o desempenho da unidade.",
  input_schema: {
    type: "object",
    properties: {
      ano: { type: "integer", description: "Ano de referência (ex.: 2026). Se omitido, usa o ano atual." },
      mes: { type: "integer", description: "Mês de referência, de 1 a 12. Se omitido, usa o mês atual." },
    },
    additionalProperties: false,
  },
};

/**
 * @param {{ano?: number, mes?: number}} input
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto
 * @param {{obterMes: typeof dashboardExecutivoService.obterMes}} [deps] injeção para teste.
 */
export async function executar(input, { organizacaoId, unidadeId, acesso }, deps = { obterMes: dashboardExecutivoService.obterMes }) {
  garantirAcessoModulo(acesso, MODULOS.IFOOD_DASHBOARD);
  garantirPermissao(acesso, PERMISSOES.DASHBOARD_EXECUTIVO_VER);

  const { ano, mes } = resolverPeriodo(input);

  const dados = await deps.obterMes({
    organizacaoId,
    unidadeIdSessao: unidadeId,
    unidadeIdSolicitado: undefined, // NUNCA do modelo.
    ano,
    mes,
  });

  // Visão agregada ("todas as unidades") nunca tem diagnóstico — mesma regra
  // já aplicada na tela (metas variam por modelo logístico entre unidades,
  // então o motor não roda nesse caso). Honesto > inventado: diz que não há.
  if (dados.agregado) {
    return {
      visao: "todas_as_unidades",
      periodo: dados.periodo,
      semDiagnostico: true,
      motivo: "O diagnóstico automático é calculado por unidade específica — selecione uma unidade para obtê-lo.",
    };
  }

  return {
    visao: "unidade",
    periodo: dados.periodo,
    faturamento: dados.cards.faturamento,
    diagnostico: dados.diagnostico,
  };
}
