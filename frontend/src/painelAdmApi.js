// Cliente da API do PAINEL ADMINISTRATIVO (/api/v1/administrativo).
//
// AUTENTICAÇÃO: a mesma do resto do frontend — o Bearer do Supabase
// (`tokenAtual()`), que é a IDENTIDADE. Não há autenticação paralela.
//
// DIFERENÇA DELIBERADA em relação a sessao.js#http: aqui NUNCA vai o header
// `x-context-token`. O Painel Administrativo não opera sob o contexto de
// nenhuma empresa (igual ao Painel SuperAdmin) — mandar o token de contexto
// seria semanticamente errado, mesmo que o backend o ignore nessas rotas.
import { API_BASE } from "./config.js";
import { tokenAtual } from "./supabaseClient.js";

const BASE = "/api/v1/administrativo";

/** Monta a query string, descartando vazios / "todos". @param {Record<string, unknown>} p */
function qs(p = {}) {
  const s = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "todos")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
}

async function chamar(rota, opcoes = {}) {
  const token = await tokenAtual();
  const r = await fetch(API_BASE + BASE + rota, {
    ...opcoes,
    headers: {
      ...(opcoes.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = typeof corpo.error === "string" ? corpo.error : (corpo.error?.message ?? `${r.status} ${r.statusText}`);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return corpo.data ?? corpo;
}

export const painelAdmApi = {
  /**
   * Sanidade + validação REAL do acesso. 200 = pode entrar; 403 = acesso não
   * está mais disponível (ex.: SuperAdmin revogou depois da tela carregada).
   */
  ping: () => chamar("/ping"),

  // -- Monitoramento. Só leitura, Bearer, sem x-context-token. --
  //
  // PERÍODO ATIVO: todos aceitam `mes=AAAA-MM` (opcional). Ausente = mês
  // corrente. O backend deriva o dia de referência do período: D-1 no mês
  // corrente, último dia num mês já fechado.

  /** Resumo consolidado + "Ação Necessária Hoje" + rollup por empresa. */
  visaoGeral: ({ mes } = {}) => chamar("/visao-geral" + qs({ mes })),

  /**
   * Lista de unidades num dia. Sem `data`, usa o dia de referência do `mes`.
   * Filtros server-side: `mes`, `data` (AAAA-MM-DD, nunca hoje/futuro),
   * `organizacaoId`, `status` (categoria do D-1), `criticidade`.
   * A busca textual é client-side.
   * @param {{mes?: string, data?: string, organizacaoId?: string, status?: string, criticidade?: string}} [filtros]
   */
  monitoramentoDiario: (filtros = {}) => chamar("/monitoramento-diario" + qs(filtros)),

  /** Só unidades não-em-dia. Ordem (CRÍTICO → mais antigo → ATENÇÃO) vem pronta. */
  pendencias: ({ mes } = {}) => chamar("/pendencias" + qs({ mes })),

  /** Rollup por organização (conformidade = Σ/Σ). */
  empresas: ({ mes } = {}) => chamar("/empresas" + qs({ mes })),

  /** Detalhe de uma empresa: resumo + unidades + pendências. */
  detalheEmpresa: (organizacaoId, { mes } = {}) =>
    chamar(`/empresas/${encodeURIComponent(organizacaoId)}` + qs({ mes })),

  /**
   * Calendário mensal de uma unidade — abre no `mes` do período ativo.
   * @param {string} unidadeId
   * @param {string} [mes] AAAA-MM (padrão: mês corrente do backend)
   */
  calendarioUnidade: (unidadeId, mes) =>
    chamar(`/unidades/${encodeURIComponent(unidadeId)}/calendario` + qs({ mes })),

  // -- Financeiro / Relatórios --
  //
  // Rotas próprias de propósito: o ranking completo não pertence ao payload da
  // Visão Geral (que carrega só o consolidado e os líderes).

  /** Ranking por faturamento absoluto. `escopo`: empresas | unidades. */
  rankingFaturamento: ({ mes, escopo, limite } = {}) =>
    chamar("/rankings/faturamento" + qs({ mes, escopo, limite })),

  /** Ranking por conformidade. `ordem=asc` = quem precisa de mais atenção. */
  rankingConformidade: ({ mes, escopo, ordem, limite } = {}) =>
    chamar("/rankings/conformidade" + qs({ mes, escopo, ordem, limite })),

  /** Relatório executivo do período (operação + conformidade + financeiro). */
  relatorioResumo: ({ mes, topN } = {}) => chamar("/relatorios/resumo" + qs({ mes, topN })),

  /** Pacote COMPLETO do relatório executivo — a fonte única do PDF. */
  relatorioExecutivo: ({ mes, topN } = {}) => chamar("/relatorios/executivo" + qs({ mes, topN })),

  /** Série diária de faturamento — rede inteira ou uma empresa. */
  relatorioEvolucao: ({ mes, organizacaoId } = {}) =>
    chamar("/relatorios/evolucao" + qs({ mes, organizacaoId })),
};
