// Financeiro do SaaS — planos, assinaturas, cobranças e as métricas clássicas.
//
// O que já é REAL: o modelo de dados, o CRUD e o cálculo de MRR/ARR/churn e
// inadimplência a partir das assinaturas e cobranças gravadas.
// O que ainda NÃO existe: emissão automática de cobrança e conciliação com
// gateway de pagamento. A porta para isso está aberta em
// `cobrancas.referencia_externa` + `metodo`, e o cálculo abaixo não precisa
// mudar quando o gateway chegar — ele lê a mesma tabela.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { buscar, inicioDoMes } from "./plataforma.repo.js";
import * as v from "../../shared/validar.js";

export const STATUS_ASSINATURA = ["trial", "ativa", "inadimplente", "cancelada"];
export const CICLOS = ["mensal", "anual"];
export const STATUS_COBRANCA = ["pendente", "paga", "vencida", "cancelada", "estornada"];

/** Normaliza o valor de uma assinatura para receita MENSAL. @param {{ciclo: string, valor: number}} a */
function valorMensal(a) {
  const valor = Number(a.valor) || 0;
  return a.ciclo === "anual" ? valor / 12 : valor;
}

/**
 * Métricas do SaaS.
 *
 * MRR = soma normalizada das assinaturas em cobrança (ativa + inadimplente).
 *   Inadimplente entra no MRR de propósito: o contrato existe e é receita
 *   contratada; tirá-lo do MRR e ainda contá-lo em "inadimplentes" esconderia
 *   o tamanho do problema. Trial não entra — não há receita.
 *
 * Churn = canceladas nos últimos 30 dias / base que existia no início do
 *   período (ativas hoje + canceladas no período). É o churn de CONTAS, não de
 *   receita; com a base pequena de um SaaS novo, ele é volátil por natureza.
 */
export async function calcularMetricas() {
  const trintaDiasAtras = new Date(Date.now() - 30 * 86400_000).toISOString();
  const mesAtual = inicioDoMes();
  const hoje = new Date().toISOString().slice(0, 10);

  const [assinaturas, canceladas, cobrancas] = await Promise.all([
    buscar("assinaturas", "id, organizacao_id, status, ciclo, valor", (q) => q.is("cancelado_em", null)),
    buscar("assinaturas", "id", (q) => q.gte("cancelado_em", trintaDiasAtras)),
    buscar("cobrancas", "organizacao_id, valor, status, vencimento, competencia, pago_em"),
  ]);

  const emCobranca = assinaturas.filter((a) => a.status === "ativa" || a.status === "inadimplente");
  const mrr = emCobranca.reduce((s, a) => s + valorMensal(a), 0);

  const ativasHoje = assinaturas.filter((a) => a.status === "ativa").length;
  const base = ativasHoje + canceladas.length;
  const churnPct = base > 0 ? (canceladas.length / base) * 100 : 0;

  // Inadimplente = tem cobrança vencida, ou pendente com vencimento no passado.
  // Contar empresas distintas, não cobranças: três faturas atrasadas da mesma
  // empresa são um cliente inadimplente, não três.
  const emAtraso = cobrancas.filter((c) =>
    c.status === "vencida" || (c.status === "pendente" && c.vencimento < hoje));
  const inadimplentes = new Set(emAtraso.map((c) => c.organizacao_id)).size;

  const aReceber = emAtraso.reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const recebidoNoMes = cobrancas
    .filter((c) => c.status === "paga" && String(c.competencia) >= mesAtual)
    .reduce((s, c) => s + (Number(c.valor) || 0), 0);

  return {
    mrr: round2(mrr),
    arr: round2(mrr * 12),
    churnPct: round2(churnPct),
    assinaturasAtivas: ativasHoje,
    assinaturasTrial: assinaturas.filter((a) => a.status === "trial").length,
    assinaturasInadimplentes: assinaturas.filter((a) => a.status === "inadimplente").length,
    canceladas30d: canceladas.length,
    inadimplentes,
    aReceber: round2(aReceber),
    recebidoNoMes: round2(recebidoNoMes),
    ticketMedio: emCobranca.length ? round2(mrr / emCobranca.length) : 0,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

// --------------------------------------------------------------------------
// Planos
// --------------------------------------------------------------------------

export async function listarPlanos() {
  const { data, error } = await supabase.from("planos")
    .select("*").order("ordem").order("preco_mensal");
  if (error) throw ApiError.internal(error.message);

  // Quantas empresas em cada plano — o painel precisa disso para decidir preço.
  const orgs = await buscar("organizacoes", "plano_id");
  const uso = new Map();
  for (const o of orgs) if (o.plano_id) uso.set(o.plano_id, (uso.get(o.plano_id) ?? 0) + 1);

  return (data ?? []).map((p) => ({ ...p, empresas: uso.get(p.id) ?? 0 }));
}

/** @param {Record<string, unknown>} body */
export async function criarPlano(body) {
  const dados = {
    codigo: v.texto(body.codigo, "Código", { max: 40 }).toLowerCase().replace(/[^a-z0-9_-]/g, ""),
    nome: v.texto(body.nome, "Nome", { max: 80 }),
    descricao: v.textoOpcional(body.descricao, "Descrição", { max: 400 }),
    preco_mensal: v.numeroOpcional(body.precoMensal, "Preço mensal", { min: 0, max: 1_000_000 }),
    preco_anual: v.numeroOpcional(body.precoAnual, "Preço anual", { min: 0, max: 10_000_000 }),
    limite_unidades: body.limiteUnidades == null || body.limiteUnidades === "" ? null : v.numero(body.limiteUnidades, "Limite de unidades", { min: 1, max: 10_000 }),
    limite_usuarios: body.limiteUsuarios == null || body.limiteUsuarios === "" ? null : v.numero(body.limiteUsuarios, "Limite de usuários", { min: 1, max: 100_000 }),
    ativo: v.booleano(body.ativo, true),
    ordem: v.numeroOpcional(body.ordem, "Ordem", { min: 0, max: 999 }),
  };
  if (!dados.codigo) throw ApiError.badRequest("Código do plano inválido.");

  const { data, error } = await supabase.from("planos").insert(dados).select("*").single();
  if (error) {
    if (error.message.includes("duplicate")) throw ApiError.badRequest("Já existe um plano com este código.");
    throw ApiError.internal(error.message);
  }
  return data;
}

/** @param {string} id @param {Record<string, unknown>} body */
export async function atualizarPlano(id, body) {
  const patch = {};
  if (body.nome !== undefined) patch.nome = v.texto(body.nome, "Nome", { max: 80 });
  if (body.descricao !== undefined) patch.descricao = v.textoOpcional(body.descricao, "Descrição", { max: 400 });
  if (body.precoMensal !== undefined) patch.preco_mensal = v.numero(body.precoMensal, "Preço mensal", { min: 0, max: 1_000_000 });
  if (body.precoAnual !== undefined) patch.preco_anual = v.numero(body.precoAnual, "Preço anual", { min: 0, max: 10_000_000 });
  if (body.limiteUnidades !== undefined) patch.limite_unidades = body.limiteUnidades === null || body.limiteUnidades === "" ? null : v.numero(body.limiteUnidades, "Limite de unidades", { min: 1, max: 10_000 });
  if (body.limiteUsuarios !== undefined) patch.limite_usuarios = body.limiteUsuarios === null || body.limiteUsuarios === "" ? null : v.numero(body.limiteUsuarios, "Limite de usuários", { min: 1, max: 100_000 });
  if (body.ativo !== undefined) patch.ativo = v.booleano(body.ativo, true);
  if (body.ordem !== undefined) patch.ordem = v.numero(body.ordem, "Ordem", { min: 0, max: 999 });
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  const { data, error } = await supabase.from("planos")
    .update(patch).eq("id", v.uuid(id, "Plano")).select("*").single();
  if (error || !data) throw ApiError.notFound("Plano não encontrado.");
  return data;
}

// --------------------------------------------------------------------------
// Assinaturas
// --------------------------------------------------------------------------

export async function listarAssinaturas({ status = null, organizacaoId = null } = {}) {
  let q = supabase.from("assinaturas")
    .select("*, organizacoes(id, nome, status), planos(id, nome, codigo)")
    .order("created_at", { ascending: false });
  if (status) q = q.eq("status", v.umDe(status, "Status", STATUS_ASSINATURA));
  if (organizacaoId) q = q.eq("organizacao_id", v.uuid(organizacaoId, "Empresa"));

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map(formatarAssinatura);
}

const formatarAssinatura = (a) => ({
  id: a.id,
  empresa: a.organizacoes ? { id: a.organizacoes.id, nome: a.organizacoes.nome, status: a.organizacoes.status } : null,
  plano: a.planos ? { id: a.planos.id, nome: a.planos.nome, codigo: a.planos.codigo } : null,
  status: a.status,
  ciclo: a.ciclo,
  valor: Number(a.valor) || 0,
  valorMensalizado: round2(valorMensal(a)),
  inicioEm: a.inicio_em,
  proximaCobrancaEm: a.proxima_cobranca_em,
  canceladoEm: a.cancelado_em,
  motivoCancelamento: a.motivo_cancelamento,
});

/**
 * Cria (ou substitui) a assinatura viva de uma empresa.
 * O índice único parcial do banco garante uma assinatura viva por empresa —
 * então a anterior é cancelada antes, em vez de deixar o insert falhar.
 * @param {Record<string, unknown>} body
 */
export async function criarAssinatura(body) {
  const organizacaoId = v.uuid(body.organizacaoId, "Empresa");
  const planoId = v.uuid(body.planoId, "Plano");
  const ciclo = v.umDeOpcional(body.ciclo, "Ciclo", CICLOS, "mensal");
  const status = v.umDeOpcional(body.status, "Status", STATUS_ASSINATURA, "ativa");

  const { data: plano } = await supabase.from("planos")
    .select("id, preco_mensal, preco_anual").eq("id", planoId).maybeSingle();
  if (!plano) throw ApiError.notFound("Plano não encontrado.");

  // Sem valor explícito, herda o preço de tabela do plano no ciclo escolhido.
  const valor = body.valor === undefined || body.valor === null || body.valor === ""
    ? Number(ciclo === "anual" ? plano.preco_anual : plano.preco_mensal)
    : v.numero(body.valor, "Valor", { min: 0, max: 10_000_000 });

  await supabase.from("assinaturas")
    .update({ cancelado_em: new Date().toISOString(), status: "cancelada", motivo_cancelamento: "substituída por nova assinatura" })
    .eq("organizacao_id", organizacaoId).is("cancelado_em", null);

  const { data, error } = await supabase.from("assinaturas").insert({
    organizacao_id: organizacaoId, plano_id: planoId, status, ciclo, valor,
    inicio_em: v.dataOpcional(body.inicioEm, "Início") ?? new Date().toISOString().slice(0, 10),
    proxima_cobranca_em: v.dataOpcional(body.proximaCobrancaEm, "Próxima cobrança"),
  }).select("*, organizacoes(id, nome, status), planos(id, nome, codigo)").single();
  if (error) throw ApiError.internal(error.message);

  // Mantém organizacoes.plano_id coerente — é por ele que o painel de Empresas
  // mostra o plano sem precisar de join com assinaturas.
  await supabase.from("organizacoes").update({ plano_id: planoId }).eq("id", organizacaoId);

  return formatarAssinatura(data);
}

/** @param {string} id @param {Record<string, unknown>} body */
export async function atualizarAssinatura(id, body) {
  const patch = {};
  if (body.status !== undefined) patch.status = v.umDe(body.status, "Status", STATUS_ASSINATURA);
  if (body.ciclo !== undefined) patch.ciclo = v.umDe(body.ciclo, "Ciclo", CICLOS);
  if (body.valor !== undefined) patch.valor = v.numero(body.valor, "Valor", { min: 0, max: 10_000_000 });
  if (body.proximaCobrancaEm !== undefined) patch.proxima_cobranca_em = v.dataOpcional(body.proximaCobrancaEm, "Próxima cobrança");
  if (body.cancelar !== undefined && v.booleano(body.cancelar)) {
    patch.cancelado_em = new Date().toISOString();
    patch.status = "cancelada";
    patch.motivo_cancelamento = v.textoOpcional(body.motivoCancelamento, "Motivo", { max: 300 });
  }
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  const { data, error } = await supabase.from("assinaturas")
    .update(patch).eq("id", v.uuid(id, "Assinatura"))
    .select("*, organizacoes(id, nome, status), planos(id, nome, codigo)").single();
  if (error || !data) throw ApiError.notFound("Assinatura não encontrada.");
  return formatarAssinatura(data);
}

// --------------------------------------------------------------------------
// Cobranças
// --------------------------------------------------------------------------

export async function listarCobrancas({ status = null, organizacaoId = null, limite } = {}) {
  let q = supabase.from("cobrancas")
    .select("*, organizacoes(id, nome)")
    .order("vencimento", { ascending: false })
    .limit(v.limite(limite, 100, 1, 500));
  if (status) q = q.eq("status", v.umDe(status, "Status", STATUS_COBRANCA));
  if (organizacaoId) q = q.eq("organizacao_id", v.uuid(organizacaoId, "Empresa"));

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);

  const hoje = new Date().toISOString().slice(0, 10);
  return (data ?? []).map((c) => ({
    id: c.id,
    empresa: c.organizacoes ? { id: c.organizacoes.id, nome: c.organizacoes.nome } : null,
    competencia: c.competencia,
    valor: Number(c.valor) || 0,
    status: c.status,
    vencimento: c.vencimento,
    pagoEm: c.pago_em,
    metodo: c.metodo,
    referenciaExterna: c.referencia_externa,
    // Atrasada é derivado, não persistido: um cron que marque 'vencida' pode
    // não ter rodado, e o painel não deve depender dele para dizer a verdade.
    atrasada: c.status === "pendente" && c.vencimento < hoje,
  }));
}

/** @param {Record<string, unknown>} body */
export async function criarCobranca(body) {
  const organizacaoId = v.uuid(body.organizacaoId, "Empresa");
  const competencia = v.dataOpcional(body.competencia, "Competência") ?? inicioDoMes();
  const dados = {
    organizacao_id: organizacaoId,
    assinatura_id: v.uuidOpcional(body.assinaturaId, "Assinatura"),
    competencia,
    valor: v.numero(body.valor, "Valor", { min: 0, max: 10_000_000 }),
    status: v.umDeOpcional(body.status, "Status", STATUS_COBRANCA, "pendente"),
    vencimento: v.dataOpcional(body.vencimento, "Vencimento") ?? competencia,
    metodo: v.textoOpcional(body.metodo, "Método", { max: 40 }),
    referencia_externa: v.textoOpcional(body.referenciaExterna, "Referência", { max: 120 }),
  };

  const { data, error } = await supabase.from("cobrancas").insert(dados).select("id").single();
  if (error) {
    if (error.message.includes("duplicate")) {
      throw ApiError.badRequest("Já existe cobrança desta empresa para esta competência.");
    }
    throw ApiError.internal(error.message);
  }
  return { id: data.id };
}

/** @param {string} id @param {Record<string, unknown>} body */
export async function atualizarCobranca(id, body) {
  const patch = {};
  if (body.status !== undefined) {
    patch.status = v.umDe(body.status, "Status", STATUS_COBRANCA);
    // Marcar como paga sem data de pagamento deixaria o relatório de recebidos
    // furado — então a data entra automaticamente.
    if (patch.status === "paga") patch.pago_em = new Date().toISOString();
    if (patch.status !== "paga") patch.pago_em = null;
  }
  if (body.valor !== undefined) patch.valor = v.numero(body.valor, "Valor", { min: 0, max: 10_000_000 });
  if (body.vencimento !== undefined) patch.vencimento = v.dataOpcional(body.vencimento, "Vencimento");
  if (body.metodo !== undefined) patch.metodo = v.textoOpcional(body.metodo, "Método", { max: 40 });
  if (body.referenciaExterna !== undefined) patch.referencia_externa = v.textoOpcional(body.referenciaExterna, "Referência", { max: 120 });
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  const { data, error } = await supabase.from("cobrancas")
    .update(patch).eq("id", v.uuid(id, "Cobrança")).select("id").single();
  if (error || !data) throw ApiError.notFound("Cobrança não encontrada.");
  return { id: data.id, ...patch };
}

/** Panorama consolidado — o que a aba "Financeiro do SaaS" abre por padrão. */
export async function obterPanorama() {
  const [metricas, planos, assinaturas, cobrancas] = await Promise.all([
    calcularMetricas(),
    listarPlanos(),
    listarAssinaturas(),
    listarCobrancas({ limite: 100 }),
  ]);
  return {
    metricas,
    planos,
    assinaturas,
    cobrancas,
    inadimplentes: cobrancas.filter((c) => c.status === "vencida" || c.atrasada),
  };
}
