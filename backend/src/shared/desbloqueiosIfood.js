// DESBLOQUEIO ADMINISTRATIVO de dias do Dashboard iFood (migration 068).
//
// POR QUE ESTE ARQUIVO É `shared/`
//   Dois mundos falam com a mesma tabela e não podem depender um do outro:
//     * TENANT   — o Dashboard iFood LÊ as datas liberadas para decidir
//                  disponibilidade (dashboardExecutivo.service.js);
//     * PAINEL   — o Painel Administrativo ESCREVE (cria/revoga) e lista o
//                  histórico (administrativo.*).
//   Se a leitura morasse no módulo `administrativo`, o mundo do tenant
//   passaria a importar o mundo administrativo — exatamente a inversão que a
//   arquitetura evita. Aqui os dois importam de um lugar neutro.
//
// O QUE UM DESBLOQUEIO É
//   Uma PERMISSÃO por (empresa, unidade, data): levanta, só naquela data, a
//   janela D-1 do Financeiro e a trava sequencial. Nada mais. Não cria
//   lançamento, não preenche valor, não conclui o dia. Ver o cabeçalho da
//   migration 068 para o contrato completo.
//
// Usa `supabase` (service_role) como o resto do backend; a AUTORIZAÇÃO de
// quem pode criar/revogar vive no middleware do painel
// (`requirePainelAdministrativo`), nunca aqui.

import { supabase } from "../config/supabase.js";
import { ApiError } from "./ApiError.js";

export const TABELA_DESBLOQUEIOS = "dashboard_ifood_desbloqueios";

/** Único tipo existente hoje; a coluna aceita novos sem nova migration. */
export const TIPO_DESBLOQUEIO = "financeiro_dashboard_ifood";

export const STATUS_DESBLOQUEIO = { ATIVO: "ativo", REVOGADO: "revogado" };

/**
 * Motivos canônicos (o painel oferece estes; "outro" exige observação).
 * Chave = valor gravado; rótulo = o que a UI mostra.
 */
export const MOTIVOS_DESBLOQUEIO = {
  dia_nao_lancado: "Dia não lançado pela unidade",
  falha_operacional: "Falha operacional",
  dados_posteriores: "Dados disponíveis posteriormente",
  correcao_administrativa: "Correção administrativa",
  outro: "Outro",
};

export const MOTIVOS_VALIDOS = Object.keys(MOTIVOS_DESBLOQUEIO);

// Colunas lidas pelo painel (histórico completo). A leitura quente do
// Dashboard iFood pede menos que isso — ver `carregarDatasLiberadas`.
const COLUNAS = [
  "id", "organizacao_id", "unidade_id", "data_referencia", "tipo", "motivo",
  "observacao", "status", "criado_por", "criado_por_nome", "criado_por_email",
  "criado_em", "revogado_por", "revogado_por_nome", "revogado_em",
].join(", ");

/** Linha crua -> forma da API (camelCase), com o rótulo do motivo já resolvido. */
export function desbloqueioParaApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizacaoId: row.organizacao_id,
    unidadeId: row.unidade_id,
    data: row.data_referencia,
    tipo: row.tipo,
    motivo: row.motivo,
    motivoRotulo: MOTIVOS_DESBLOQUEIO[row.motivo] ?? row.motivo,
    observacao: row.observacao ?? null,
    status: row.status,
    ativo: row.status === STATUS_DESBLOQUEIO.ATIVO,
    criadoPor: row.criado_por ?? null,
    criadoPorNome: row.criado_por_nome ?? null,
    criadoPorEmail: row.criado_por_email ?? null,
    criadoEm: row.criado_em ?? null,
    revogadoPor: row.revogado_por ?? null,
    revogadoPorNome: row.revogado_por_nome ?? null,
    revogadoEm: row.revogado_em ?? null,
  };
}

// ---------------------------------------------------------------------------
// LEITURA — caminho quente do Dashboard iFood
// ---------------------------------------------------------------------------

/**
 * Datas ATIVAS liberadas de UMA unidade num intervalo. Uma query; devolve um
 * Set pronto para `statusMes({ desbloqueios })`.
 *
 * Tolerante à tabela ausente: num banco onde a migration 068 ainda não rodou,
 * devolve Set vazio em vez de derrubar o Dashboard iFood inteiro — o
 * comportamento resultante é exatamente o de antes da exceção existir. É a
 * mesma escolha de `insumos.service.js#semColunasNovas`.
 * @param {{unidadeId: string, desdeIso: string, ateIso: string}} p
 * @param {{supabase?: any}} [deps]
 * @returns {Promise<Set<string>>}
 */
export async function carregarDatasLiberadas({ unidadeId, desdeIso, ateIso }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA_DESBLOQUEIOS)
    .select("data_referencia")
    .eq("unidade_id", unidadeId)
    .eq("tipo", TIPO_DESBLOQUEIO)
    .eq("status", STATUS_DESBLOQUEIO.ATIVO)
    .gte("data_referencia", desdeIso)
    .lte("data_referencia", ateIso);
  if (error) {
    if (tabelaAusente(error)) return new Set();
    throw ApiError.internal(error.message);
  }
  return new Set((data ?? []).map((r) => r.data_referencia));
}

/**
 * Idem, para VÁRIAS unidades — uma query por lote, nunca `for unidade:
 * SELECT` (mesma disciplina de administrativo.repo.js).
 * @param {{unidadeIds: string[], desdeIso: string, ateIso: string}} p
 * @param {{supabase?: any}} [deps]
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function carregarDatasLiberadasDaFrota({ unidadeIds, desdeIso, ateIso }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const porUnidade = new Map((unidadeIds ?? []).map((id) => [id, new Set()]));
  if (!unidadeIds?.length) return porUnidade;

  for (const lote of emLotes(unidadeIds)) {
    const { data, error } = await db.from(TABELA_DESBLOQUEIOS)
      .select("unidade_id, data_referencia")
      .in("unidade_id", lote)
      .eq("tipo", TIPO_DESBLOQUEIO)
      .eq("status", STATUS_DESBLOQUEIO.ATIVO)
      .gte("data_referencia", desdeIso)
      .lte("data_referencia", ateIso);
    if (error) {
      if (tabelaAusente(error)) return porUnidade;
      throw ApiError.internal(error.message);
    }
    for (const row of data ?? []) porUnidade.get(row.unidade_id)?.add(row.data_referencia);
  }
  return porUnidade;
}

/**
 * Histórico COMPLETO (ativos e revogados) de uma unidade num intervalo — é o
 * que alimenta a linha do tempo do painel. Ordenado por data e, dentro da
 * data, do mais recente para o mais antigo.
 * @param {{unidadeId: string, desdeIso: string, ateIso: string}} p
 * @param {{supabase?: any}} [deps]
 */
export async function listarDesbloqueios({ unidadeId, desdeIso, ateIso }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA_DESBLOQUEIOS)
    .select(COLUNAS)
    .eq("unidade_id", unidadeId)
    .gte("data_referencia", desdeIso)
    .lte("data_referencia", ateIso);
  if (error) {
    if (tabelaAusente(error)) return [];
    throw ApiError.internal(error.message);
  }
  // Ordena em memória, não no PostgREST: o recorte é de UMA unidade em dois
  // meses (dezenas de linhas no pior caso), então a ordenação é de graça — e
  // manter a query no subconjunto mínimo do cliente (`from/select/eq/gte/lte`)
  // é o que deixa os testes do painel injetarem um Supabase falso simples.
  return (data ?? [])
    .map(desbloqueioParaApi)
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : String(b.criadoEm ?? "").localeCompare(String(a.criadoEm ?? ""))));
}

/**
 * Um desbloqueio ATIVO pelo id, SEMPRE preso a uma unidade — um id de outra
 * unidade simplesmente não é encontrado. É o mesmo isolamento que o
 * `.eq("unidade_id")` do UPDATE em `revogarDesbloqueio`, aplicado na leitura
 * que decide se a revogação pode acontecer.
 */
export async function obterDesbloqueioAtivoPorId({ id, unidadeId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA_DESBLOQUEIOS)
    .select(COLUNAS)
    .eq("id", id)
    .eq("unidade_id", unidadeId)
    .eq("status", STATUS_DESBLOQUEIO.ATIVO)
    .maybeSingle();
  if (error) {
    if (tabelaAusente(error)) return null;
    throw ApiError.internal(error.message);
  }
  return desbloqueioParaApi(data);
}

/** O desbloqueio ATIVO de uma data exata, ou null. */
export async function obterDesbloqueioAtivo({ unidadeId, dataIso }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA_DESBLOQUEIOS)
    .select(COLUNAS)
    .eq("unidade_id", unidadeId)
    .eq("data_referencia", dataIso)
    .eq("tipo", TIPO_DESBLOQUEIO)
    .eq("status", STATUS_DESBLOQUEIO.ATIVO)
    .maybeSingle();
  if (error) {
    if (tabelaAusente(error)) return null;
    throw ApiError.internal(error.message);
  }
  return desbloqueioParaApi(data);
}

// ---------------------------------------------------------------------------
// ESCRITA — só o Painel Administrativo chega aqui
// ---------------------------------------------------------------------------

/**
 * Cria um desbloqueio ATIVO. `organizacaoId` vem SEMPRE da unidade resolvida
 * pelo chamador (nunca do corpo da requisição) — ver o cabeçalho da 068.
 *
 * A unicidade real é do índice parcial no banco; a violação vira 409, não 500,
 * porque "já está liberado" é resposta de negócio, não falha.
 * @param {{organizacaoId: string, unidadeId: string, dataIso: string, motivo: string, observacao?: string|null, autor: {id?: string|null, nome?: string|null, email?: string|null}}} p
 * @param {{supabase?: any}} [deps]
 */
export async function criarDesbloqueio({ organizacaoId, unidadeId, dataIso, motivo, observacao = null, autor = {} }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const linha = {
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    data_referencia: dataIso,
    tipo: TIPO_DESBLOQUEIO,
    motivo,
    observacao,
    status: STATUS_DESBLOQUEIO.ATIVO,
    criado_por: autor.id ?? null,
    criado_por_nome: autor.nome ?? null,
    criado_por_email: autor.email ?? null,
  };
  const { data, error } = await db.from(TABELA_DESBLOQUEIOS).insert(linha).select(COLUNAS).single();
  if (error) {
    if (tabelaAusente(error)) {
      throw ApiError.internal("A migration 068 (dashboard_ifood_desbloqueios) ainda não foi aplicada neste banco.");
    }
    if (/duplicate key|unique/i.test(error.message ?? "")) {
      throw new ApiError(409, "Este dia já está liberado para esta unidade.");
    }
    throw ApiError.badRequest(error.message);
  }
  return desbloqueioParaApi(data);
}

/**
 * Revoga um desbloqueio ATIVO. Nunca apaga a linha — o histórico é o produto.
 * Filtra por `status = ativo` no próprio UPDATE: duas revogações concorrentes
 * não se sobrescrevem, a segunda simplesmente não encontra nada.
 * @param {{id: string, unidadeId: string, autor: {id?: string|null, nome?: string|null}}} p
 * @param {{supabase?: any}} [deps]
 */
export async function revogarDesbloqueio({ id, unidadeId, autor = {} }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from(TABELA_DESBLOQUEIOS)
    .update({
      status: STATUS_DESBLOQUEIO.REVOGADO,
      revogado_por: autor.id ?? null,
      revogado_por_nome: autor.nome ?? null,
      revogado_em: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("unidade_id", unidadeId)          // isolamento: id de outra unidade não revoga aqui
    .eq("status", STATUS_DESBLOQUEIO.ATIVO)
    .select(COLUNAS)
    .maybeSingle();
  if (error) {
    if (tabelaAusente(error)) throw ApiError.notFound("Liberação não encontrada.");
    throw ApiError.badRequest(error.message);
  }
  if (!data) throw ApiError.notFound("Liberação não encontrada ou já revogada.");
  return desbloqueioParaApi(data);
}

// ---------------------------------------------------------------------------

// PostgREST devolve 42P01 (ou a mensagem) quando a tabela não existe — banco
// sem a migration 068 aplicada.
function tabelaAusente(error) {
  return error?.code === "42P01" || /relation .* does not exist|could not find the table/i.test(error?.message ?? "");
}

const LOTE_IN = 200;
function emLotes(arr, n = LOTE_IN) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
