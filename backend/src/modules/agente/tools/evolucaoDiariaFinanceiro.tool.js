// Tool "consultar_evolucao_diaria_financeiro" — Etapa H (Diagnóstico
// Investigativo). Expõe a série diária financeira JÁ CALCULADA
// (dashboardExecutivo.calc.js#listaSnapshotsFinanceiros, a MESMA que já
// alimenta o gráfico "Evolução do Financeiro acumulado" da tela) — nunca
// recalcula nada, só filtra pros dias de MAIOR variação e devolve um
// recorte enxuto.
//
// REGRA DE OURO: "variacao" é o delta REAL entre dois snapshots CONHECIDOS
// do mês (nunca interpolado — snapshots têm buracos quando um dia não foi
// lançado) — é o dado mais direto disponível hoje pra sustentar "dias que
// mais pressionaram o indicador" com evidência real, sem N chamadas a
// consultar_dashboard_dia (que só traz 1 dia por vez).
//
// LIMITAÇÃO HONESTA (documentada na própria description, pro Claude nunca
// forçar uma leitura que os dados não sustentam): a variação é da RECEITA
// FINANCEIRA TOTAL do snapshot, não de um indicador específico (ex.: só
// Taxas de Entregadores) — não existe, em nenhum lugar do backend hoje, uma
// série diária SÓ de um componente de dedução. Use como contexto/evidência
// correlacionada, nunca como prova isolada de causa.
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as dashboardExecutivoService from "../../dashboard-executivo/dashboardExecutivo.service.js";
import { resolverPeriodo } from "./dashboardExecutivo.tool.js";

/** Trava contra o modelo pedir a série inteira do mês — nunca mais que isto, mesmo se solicitado. */
export const MAX_DIAS_TOOL = 10;
const LIMITE_PADRAO = 5;

export const definicao = {
  name: "consultar_evolucao_diaria_financeiro",
  description:
    "Lista os dias do mês com MAIOR VARIAÇÃO (alta ou queda) no Financeiro acumulado do Dashboard Executivo (iFood) — use para responder perguntas como 'quais dias mais pressionaram/mudaram um indicador financeiro'. Cada dia traz a variação em R$ desde o snapshot anterior conhecido no mês (nunca interpolada — pode haver dias sem lançamento no meio) e o percentual de deduções totais registrado naquele dia. IMPORTANTE: a variação é da RECEITA FINANCEIRA TOTAL do dia, não de um indicador específico (ex.: não é só Taxas de Entregadores) — use como evidência de CONTEXTO/correlação, nunca como prova isolada de causa de um indicador específico.",
  input_schema: {
    type: "object",
    properties: {
      ano: { type: "integer", description: "Ano de referência (ex.: 2026). Se omitido, usa o ano atual." },
      mes: { type: "integer", description: "Mês de referência, de 1 a 12. Se omitido, usa o mês atual." },
      limite: { type: "integer", description: `Quantos dias retornar (máximo ${MAX_DIAS_TOOL}). Padrão: ${LIMITE_PADRAO}.` },
    },
    additionalProperties: false,
  },
};

/**
 * @param {{ano?: number, mes?: number, limite?: number}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{obterMes: typeof dashboardExecutivoService.obterMes}} [deps] injeção para teste.
 */
export async function executar(input, { organizacaoId, unidadeId, acesso }, deps = { obterMes: dashboardExecutivoService.obterMes }) {
  garantirAcessoModulo(acesso, MODULOS.IFOOD_DASHBOARD);
  garantirPermissao(acesso, PERMISSOES.DASHBOARD_EXECUTIVO_VER);

  const { ano, mes } = resolverPeriodo(input);
  const dados = await deps.obterMes({
    organizacaoId, unidadeIdSessao: unidadeId, unidadeIdSolicitado: undefined, ano, mes,
  });

  // Visão agregada não tem série por unidade — mesma regra de consultar_diagnostico.
  if (dados.agregado) {
    return {
      visao: "todas_as_unidades", semDados: true,
      motivo: "A evolução diária é calculada por unidade específica — selecione uma unidade para obtê-la.",
    };
  }

  // Só dias com delta CALCULÁVEL (dois snapshots conhecidos em sequência no
  // mês) — nunca inclui um dia sem base de comparação real.
  const comVariacao = (dados.snapshotsFinanceiros ?? []).filter((p) => p.delta != null);
  const limiteAplicado = Math.min(MAX_DIAS_TOOL, Math.max(1, Number(input?.limite) || LIMITE_PADRAO));
  const ranking = [...comVariacao]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limiteAplicado);

  return {
    visao: "unidade",
    periodo: dados.periodo,
    totalDiasComVariacaoCalculavel: comVariacao.length,
    dias: ranking.map((p) => ({
      data: p.data,
      variacao: p.delta,
      percentualDeducoesNesseSnapshot: p.percentualTotalDeducoes,
    })),
  };
}
