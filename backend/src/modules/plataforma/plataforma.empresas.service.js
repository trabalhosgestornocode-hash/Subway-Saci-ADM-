// Gestão das EMPRESAS CLIENTES (organizacoes) pelo SuperAdmin.
//
// Nenhuma função aqui recebe `req.tenant` — de propósito. O SuperAdmin opera
// sobre todas as empresas, então o escopo é sempre um id explícito de parâmetro
// de rota, e a autorização é o `requireSuperadmin` no router.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { permissoesDoPapel, rotuloPapel, PAPEIS_VINCULO } from "../../shared/permissoes.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { criarSessao, revogarSessoes } from "../sessao/sessao.service.js";
import { contar, buscar } from "./plataforma.repo.js";
import * as v from "../../shared/validar.js";

export const STATUS_EMPRESA = ["ativa", "teste", "bloqueada", "suspensa", "cancelada"];

/** Status em que os usuários do tenant não conseguem entrar. */
const STATUS_SEM_ACESSO = new Set(["bloqueada", "suspensa", "cancelada"]);

/**
 * @typedef {object} EmpresaResumo
 * @property {string} id
 * @property {string} nome
 * @property {string|null} cnpj
 * @property {string} status
 * @property {{id: string, nome: string}|null} plano
 * @property {number} unidades
 * @property {number} usuarios
 * @property {string} criadoEm
 */

// --------------------------------------------------------------------------
// Leitura
// --------------------------------------------------------------------------

/** @param {{busca?: string, status?: string, limite?: unknown}} filtros */
export async function listarEmpresas({ busca, status, limite } = {}) {
  let q = supabase.from("organizacoes")
    .select("id, nome, cnpj, logo_url, responsavel_nome, responsavel_email, telefone, status, trial_expira_em, ativo, created_at, planos(id, nome, codigo)")
    .order("nome")
    .limit(v.limite(limite, 200, 1, 500));

  if (status) q = q.eq("status", v.umDe(status, "Status", STATUS_EMPRESA));
  if (busca) {
    const termo = v.texto(busca, "Busca", { max: 120 }).replace(/[%,()]/g, " ");
    q = q.or(`nome.ilike.%${termo}%,cnpj.ilike.%${termo}%,responsavel_email.ilike.%${termo}%`);
  }

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  const empresas = data ?? [];
  if (!empresas.length) return [];

  // Contagens por empresa em duas consultas, não em 2N: a lista pode crescer.
  const ids = empresas.map((e) => e.id);
  const [unidades, vinculos] = await Promise.all([
    buscar("unidades", "organizacao_id", (q2) => q2.in("organizacao_id", ids).eq("ativo", true)),
    buscar("usuarios_organizacoes", "organizacao_id", (q2) => q2.in("organizacao_id", ids).eq("ativo", true)),
  ]);
  const conta = (lista) => lista.reduce((m, r) => m.set(r.organizacao_id, (m.get(r.organizacao_id) ?? 0) + 1), new Map());
  const nUnidades = conta(unidades);
  const nUsuarios = conta(vinculos);

  return empresas.map((e) => ({ ...formatarEmpresa(e), unidades: nUnidades.get(e.id) ?? 0, usuarios: nUsuarios.get(e.id) ?? 0 }));
}

const formatarEmpresa = (e) => ({
  id: e.id,
  nome: e.nome,
  cnpj: e.cnpj,
  logoUrl: e.logo_url,
  responsavelNome: e.responsavel_nome,
  responsavelEmail: e.responsavel_email,
  telefone: e.telefone,
  status: e.status,
  trialExpiraEm: e.trial_expira_em,
  plano: e.planos ? { id: e.planos.id, nome: e.planos.nome, codigo: e.planos.codigo } : null,
  criadoEm: e.created_at,
  acessoLiberado: !STATUS_SEM_ACESSO.has(e.status),
});

/** Ficha completa de uma empresa: dados, unidades, usuários e assinatura. */
export async function obterEmpresa(idBruto) {
  const id = v.uuid(idBruto, "Empresa");

  const { data: e, error } = await supabase.from("organizacoes")
    .select("id, nome, cnpj, logo_url, responsavel_nome, responsavel_email, telefone, status, trial_expira_em, observacoes, ativo, created_at, planos(id, nome, codigo)")
    .eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!e) throw ApiError.notFound("Empresa não encontrada.");

  const [unidades, assinatura, usuarios, contagens] = await Promise.all([
    buscar("unidades", "id, nome, cnpj, endereco, telefone, ativo", (q) => q.eq("organizacao_id", id).order("nome")),
    supabase.from("assinaturas")
      .select("id, status, ciclo, valor, inicio_em, proxima_cobranca_em, planos(id, nome, codigo)")
      .eq("organizacao_id", id).is("cancelado_em", null).maybeSingle()
      .then((r) => r.data ?? null),
    listarUsuariosDaEmpresa(id),
    Promise.all([
      contar("produtos", (q) => q.eq("organizacao_id", id)),
      contar("insumos", (q) => q.eq("organizacao_id", id)),
      contar("sessoes_contexto", (q) => q.eq("organizacao_id", id).is("revogada_em", null)),
    ]),
  ]);

  return {
    ...formatarEmpresa(e),
    observacoes: e.observacoes,
    unidades,
    usuarios,
    assinatura,
    metricas: { produtos: contagens[0], insumos: contagens[1], sessoesVivas: contagens[2] },
  };
}

/** Usuários vinculados a uma empresa, com o papel daquele vínculo. */
export async function listarUsuariosDaEmpresa(idBruto) {
  const id = v.uuid(idBruto, "Empresa");
  const vinculos = await buscar("usuarios_organizacoes",
    "id, usuario_id, papel, ativo, created_at", (q) => q.eq("organizacao_id", id));
  if (!vinculos.length) return [];

  const perfis = await buscar("perfis", "id, nome, email, ativo",
    (q) => q.in("id", vinculos.map((x) => x.usuario_id)));
  const porId = new Map(perfis.map((p) => [p.id, p]));

  return vinculos.map((x) => ({
    vinculoId: x.id,
    usuarioId: x.usuario_id,
    nome: porId.get(x.usuario_id)?.nome ?? null,
    email: porId.get(x.usuario_id)?.email ?? null,
    papel: x.papel,
    papelRotulo: rotuloPapel(x.papel),
    vinculoAtivo: x.ativo,
    contaAtiva: porId.get(x.usuario_id)?.ativo ?? null,
    desde: x.created_at,
  }));
}

/** Trilha de auditoria de uma empresa. */
export async function listarLogsDaEmpresa(idBruto, limiteBruto) {
  const id = v.uuid(idBruto, "Empresa");
  return (await buscar("plataforma_auditoria",
    "id, ator_email, ator_tipo, acao, entidade, entidade_id, impersonado_por, detalhes, ip, created_at",
    (q) => q.eq("organizacao_id", id).order("created_at", { ascending: false }).limit(v.limite(limiteBruto, 100))))
    .map(formatarLog);
}

const formatarLog = (l) => ({
  id: l.id, atorEmail: l.ator_email, atorTipo: l.ator_tipo, acao: l.acao,
  entidade: l.entidade, entidadeId: l.entidade_id, organizacaoId: l.organizacao_id ?? null,
  impersonado: !!l.impersonado_por, detalhes: l.detalhes, ip: l.ip, em: l.created_at,
});

// --------------------------------------------------------------------------
// Escrita
// --------------------------------------------------------------------------

/**
 * Cria uma empresa. Já nasce com uma unidade (matriz) porque o resto do
 * sistema — vendas, dashboard, Martin Brower — trabalha por unidade: uma
 * empresa sem nenhuma seria cadastrada e inutilizável ao mesmo tempo.
 * @param {import('express').Request} req
 */
export async function criarEmpresa(req, body) {
  const dados = {
    nome: v.texto(body.nome, "Nome", { max: 160 }),
    cnpj: v.cnpjOpcional(body.cnpj),
    logo_url: v.urlOpcional(body.logoUrl, "Logo"),
    responsavel_nome: v.textoOpcional(body.responsavelNome, "Responsável", { max: 160 }),
    responsavel_email: v.emailOpcional(body.responsavelEmail, "E-mail do responsável"),
    telefone: v.telefoneOpcional(body.telefone),
    status: v.umDeOpcional(body.status, "Status", STATUS_EMPRESA, "teste"),
    plano_id: v.uuidOpcional(body.planoId, "Plano"),
    trial_expira_em: body.trialDias
      ? new Date(Date.now() + v.numero(body.trialDias, "Dias de teste", { min: 1, max: 365 }) * 86400_000).toISOString()
      : null,
    observacoes: v.textoOpcional(body.observacoes, "Observações", { max: 2000 }),
  };
  dados.ativo = !STATUS_SEM_ACESSO.has(dados.status);

  const { data: empresa, error } = await supabase.from("organizacoes").insert(dados).select("id, nome, status").single();
  if (error) {
    if (error.message.includes("duplicate") || error.message.includes("unique")) {
      throw ApiError.badRequest("Já existe uma empresa com este CNPJ.");
    }
    throw ApiError.internal(error.message);
  }

  const nomeUnidade = v.textoOpcional(body.unidadeNome, "Unidade", { max: 120 }) ?? "Matriz";
  const { error: eUnidade } = await supabase.from("unidades")
    .insert({ organizacao_id: empresa.id, nome: nomeUnidade, ativo: true });
  if (eUnidade) console.error("[plataforma] empresa criada sem unidade inicial:", eUnidade.message);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_CRIADA, entidade: "organizacao", entidadeId: empresa.id,
    organizacaoId: empresa.id, detalhes: { nome: empresa.nome, status: empresa.status, unidade: nomeUnidade },
    ...origemDe(req),
  });

  return { id: empresa.id, nome: empresa.nome, status: empresa.status };
}

/** @param {import('express').Request} req */
export async function atualizarEmpresa(req, idBruto, body) {
  const id = v.uuid(idBruto, "Empresa");
  const patch = {};
  if (body.nome !== undefined) patch.nome = v.texto(body.nome, "Nome", { max: 160 });
  if (body.cnpj !== undefined) patch.cnpj = v.cnpjOpcional(body.cnpj);
  if (body.logoUrl !== undefined) patch.logo_url = v.urlOpcional(body.logoUrl, "Logo");
  if (body.responsavelNome !== undefined) patch.responsavel_nome = v.textoOpcional(body.responsavelNome, "Responsável", { max: 160 });
  if (body.responsavelEmail !== undefined) patch.responsavel_email = v.emailOpcional(body.responsavelEmail, "E-mail do responsável");
  if (body.telefone !== undefined) patch.telefone = v.telefoneOpcional(body.telefone);
  if (body.observacoes !== undefined) patch.observacoes = v.textoOpcional(body.observacoes, "Observações", { max: 2000 });
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  const { data, error } = await supabase.from("organizacoes")
    .update(patch).eq("id", id).select("id, nome").single();
  if (error || !data) throw ApiError.notFound("Empresa não encontrada.");

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_EDITADA, entidade: "organizacao", entidadeId: id, organizacaoId: id,
    detalhes: { campos: Object.keys(patch) }, ...origemDe(req),
  });
  return { id, nome: data.nome };
}

/**
 * Muda o status da empresa — é o mesmo caminho para bloquear, desbloquear,
 * suspender e reativar. Um endpoint por verbo daria quatro rotas fazendo a
 * mesma escrita, com quatro oportunidades de divergir.
 *
 * Efeito colateral obrigatório: ao entrar em status sem acesso, TODAS as
 * sessões vivas da empresa são revogadas. Bloquear sem derrubar quem já está
 * dentro não bloqueia nada.
 * @param {import('express').Request} req
 */
export async function alterarStatusEmpresa(req, idBruto, body) {
  const id = v.uuid(idBruto, "Empresa");
  const status = v.umDe(body.status, "Status", STATUS_EMPRESA);
  const motivo = v.textoOpcional(body.motivo, "Motivo", { max: 300 });

  const { data: antes } = await supabase.from("organizacoes")
    .select("id, nome, status").eq("id", id).maybeSingle();
  if (!antes) throw ApiError.notFound("Empresa não encontrada.");

  const { error } = await supabase.from("organizacoes")
    .update({ status, ativo: !STATUS_SEM_ACESSO.has(status) }).eq("id", id);
  if (error) throw ApiError.internal(error.message);

  let sessoesRevogadas = 0;
  if (STATUS_SEM_ACESSO.has(status)) {
    sessoesRevogadas = await revogarSessoes({ organizacaoId: id, motivo: `empresa_${status}` });
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_STATUS, entidade: "organizacao", entidadeId: id, organizacaoId: id,
    detalhes: { de: antes.status, para: status, motivo, sessoesRevogadas, empresa: antes.nome },
    ...origemDe(req),
  });

  return { id, status, sessoesRevogadas };
}

/** Troca o plano da empresa e reflete na assinatura viva, se houver. */
export async function alterarPlanoEmpresa(req, idBruto, body) {
  const id = v.uuid(idBruto, "Empresa");
  const planoId = v.uuid(body.planoId, "Plano");

  const [{ data: empresa }, { data: plano }] = await Promise.all([
    supabase.from("organizacoes").select("id, nome, plano_id").eq("id", id).maybeSingle(),
    supabase.from("planos").select("id, nome, preco_mensal, preco_anual").eq("id", planoId).maybeSingle(),
  ]);
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");
  if (!plano) throw ApiError.notFound("Plano não encontrado.");

  const { error } = await supabase.from("organizacoes").update({ plano_id: planoId }).eq("id", id);
  if (error) throw ApiError.internal(error.message);

  // Se existe assinatura viva, o plano dela acompanha — senão o financeiro
  // passaria a cobrar um plano diferente do que a empresa aparenta ter.
  const { data: assinatura } = await supabase.from("assinaturas")
    .select("id, ciclo").eq("organizacao_id", id).is("cancelado_em", null).maybeSingle();
  if (assinatura) {
    const valor = assinatura.ciclo === "anual" ? plano.preco_anual : plano.preco_mensal;
    await supabase.from("assinaturas").update({ plano_id: planoId, valor }).eq("id", assinatura.id);
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_PLANO, entidade: "organizacao", entidadeId: id, organizacaoId: id,
    detalhes: { de: empresa.plano_id, para: planoId, plano: plano.nome, assinaturaAtualizada: !!assinatura },
    ...origemDe(req),
  });

  return { id, planoId, assinaturaAtualizada: !!assinatura };
}

/**
 * Exclui a empresa DE VERDADE (cascata do banco leva unidades, produtos,
 * vendas, vínculos — tudo).
 *
 * Exige `confirmacao` igual ao nome exato da empresa. Um clique acidental num
 * painel de administração não pode apagar a operação inteira de um cliente, e
 * um `?confirmar=true` é fácil demais de mandar sem ler. A alternativa segura
 * (status 'cancelada') fica sugerida na mensagem de erro.
 */
export async function excluirEmpresa(req, idBruto, body) {
  const id = v.uuid(idBruto, "Empresa");
  const { data: empresa } = await supabase.from("organizacoes")
    .select("id, nome").eq("id", id).maybeSingle();
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");

  const confirmacao = typeof body?.confirmacao === "string" ? body.confirmacao.trim() : "";
  if (confirmacao !== empresa.nome) {
    throw ApiError.badRequest(
      `Exclusão não confirmada. Envie "confirmacao" com o nome exato da empresa ("${empresa.nome}"). ` +
      "Para apenas encerrar sem perder dados, use o status 'cancelada'.");
  }

  await revogarSessoes({ organizacaoId: id, motivo: "empresa_excluida" });

  // A auditoria é gravada ANTES: depois do delete não haveria mais como saber
  // o que foi apagado, e o log é imutável por design.
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_EXCLUIDA, entidade: "organizacao", entidadeId: id, organizacaoId: id,
    detalhes: { nome: empresa.nome }, ...origemDe(req),
  });

  const { error } = await supabase.from("organizacoes").delete().eq("id", id);
  if (error) throw ApiError.internal(error.message);
  return { id, nome: empresa.nome, excluida: true };
}

// --------------------------------------------------------------------------
// Entrar como empresa (impersonação auditada)
// --------------------------------------------------------------------------

/**
 * Abre uma sessão de contexto do SuperAdmin DENTRO de uma empresa.
 *
 * A sessão é do próprio superadmin (usuario_id = ele), marcada com
 * `impersonado_por`. Isso é o que faz a barra de aviso aparecer no frontend e
 * o que faz cada ação subsequente sair na auditoria carregando quem realmente
 * estava ali. Não há login como outra pessoa: ninguém age em nome de um
 * usuário do cliente — o superadmin age como ele mesmo, num contexto do
 * cliente.
 *
 * A sessão dura 1 hora, não 8: acesso de suporte deve ser curto por padrão.
 */
export async function entrarComoEmpresa(req, idBruto) {
  const id = v.uuid(idBruto, "Empresa");
  const { data: empresa } = await supabase.from("organizacoes")
    .select("id, nome, logo_url, status").eq("id", id).maybeSingle();
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");

  const papel = "organization_admin";
  const permissoes = permissoesDoPapel(papel);
  const { ip, userAgent } = origemDe(req);

  const sessao = await criarSessao({
    usuarioId: req.user.id,
    organizacaoId: id,
    unidadeId: null,
    papel,
    permissoes,
    impersonadoPor: req.user.id,
    ip, userAgent,
    validadeS: 60 * 60,
  });

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.IMPERSONAR_INICIO, entidade: "organizacao", entidadeId: id, organizacaoId: id,
    impersonadoPor: req.user.id,
    detalhes: { empresa: empresa.nome, status: empresa.status, sessionId: sessao.id },
    ip, userAgent,
  });

  // Mantém `plataforma_acessos` (migration 015) alimentada: ela é a trilha
  // específica de "superadmin acessou cliente", já usada por relatórios.
  await supabase.from("plataforma_acessos").insert({
    superadmin_id: req.user.id, organizacao_id: id, acao: "acessar_organizacao",
    contexto: { ip, userAgent, sessionId: sessao.id },
  }).then(({ error }) => { if (error) console.error("[plataforma_acessos]", error.message); });

  return {
    contextToken: sessao.token,
    expiraEm: sessao.expiraEm,
    sessionId: sessao.id,
    empresa: { id: empresa.id, nome: empresa.nome, logoUrl: empresa.logo_url, status: empresa.status },
    unidade: null,
    papel,
    papelRotulo: rotuloPapel(papel),
    permissoes,
    impersonando: true,
  };
}

/** Papéis atribuíveis, para popular os seletores do painel. */
export function papeisDisponiveis() {
  return PAPEIS_VINCULO.map((p) => ({ valor: p, rotulo: rotuloPapel(p) }));
}

/** @param {import('express').Request} req */
function origemDe(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}
