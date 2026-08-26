// Gestão das EMPRESAS CLIENTES (organizacoes) pelo SuperAdmin.
//
// Nenhuma função aqui recebe `req.tenant` — de propósito. O SuperAdmin opera
// sobre todas as empresas, então o escopo é sempre um id explícito de parâmetro
// de rota, e a autorização é o `requireSuperadmin` no router.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { permissoesDoPapel, rotuloPapel, PAPEIS_VINCULO } from "../../shared/permissoes.js";
import {
  CATALOGO_MODULOS, modulosDaEmpresa, validarModulos,
  provisionarModulosEmpresa, definirModulosEmpresa, rotuloModulo,
} from "../../shared/modulos.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { clonarCatalogo } from "../../shared/clonarCatalogo.js";
import { criarSessao, revogarSessoes } from "../sessao/sessao.service.js";
import { contar, buscar, contarVarios } from "./plataforma.repo.js";
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

/**
 * @param {{busca?: string, status?: string, limite?: unknown, ehModelo?: unknown}} filtros
 *   `ehModelo` não informado = só empresas clientes (exclui Modelos Padrão da
 *   lista principal, para não misturar molde com cliente). `ehModelo=true`
 *   é o que alimenta o seletor de "Modelo inicial" do assistente de criação.
 */
export async function listarEmpresas({ busca, status, limite, ehModelo } = {}) {
  let q = supabase.from("organizacoes")
    .select("id, nome, cnpj, logo_url, responsavel_nome, responsavel_email, telefone, status, trial_expira_em, ativo, created_at, eh_modelo, modelo_origem_id, planos(id, nome, codigo)")
    .order("nome")
    .limit(v.limite(limite, 200, 1, 500));

  q = q.eq("eh_modelo", v.booleano(ehModelo, false));
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
  ehModelo: e.eh_modelo ?? false,
  modeloOrigemId: e.modelo_origem_id ?? null,
});

/** Ficha completa de uma empresa: dados, unidades, usuários e assinatura. */
export async function obterEmpresa(idBruto) {
  const id = v.uuid(idBruto, "Empresa");

  const { data: e, error } = await supabase.from("organizacoes")
    .select("id, nome, cnpj, logo_url, responsavel_nome, responsavel_email, telefone, status, trial_expira_em, observacoes, ativo, created_at, eh_modelo, modelo_origem_id, planos(id, nome, codigo)")
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
  // Módulos e modelo inicial são validados ANTES do insert: uma empresa não
  // pode nascer com um id de módulo inexistente ou apontando para um "modelo"
  // que não existe/não é modelo — falhar depois do insert deixaria a empresa
  // criada pela metade.
  const moduloIds = validarModulos(body.modulos ?? []);
  const modeloOrigemId = await validarModeloOrigem(body.modeloOrigemId);

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
    modelo_origem_id: modeloOrigemId,
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

  // Provisiona os módulos escolhidos no assistente.
  await provisionarModulosEmpresa(empresa.id, moduloIds, req.user.id);

  // Clona o catálogo do modelo (categorias/insumos/produtos/ficha técnica/
  // preços) — se um modelo foi escolhido. NÃO fatal: a empresa, a unidade e
  // os módulos já foram gravados neste ponto, e desfazer tudo isso porque a
  // clonagem falhou seria pior do que entregar uma empresa criada com o
  // catálogo vazio e um aviso claro (em vez de, como antes, ficar vazia
  // SEM NENHUM aviso — que era exatamente o bug: nada avisava que a
  // clonagem nunca tinha rodado).
  let clone = null, cloneErro = null;
  if (modeloOrigemId) {
    try {
      clone = await clonarCatalogo(supabase, { origemId: modeloOrigemId, destinoId: empresa.id });
    } catch (e) {
      cloneErro = e.message;
      console.error("[plataforma] falha ao clonar catálogo do modelo para", empresa.id, ":", cloneErro);
    }
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_CRIADA, entidade: "organizacao", entidadeId: empresa.id,
    organizacaoId: empresa.id,
    detalhes: {
      nome: empresa.nome, status: empresa.status, unidade: nomeUnidade,
      modulos: moduloIds, modeloOrigemId, clone, cloneErro,
    },
    ...origemDe(req),
  });

  return {
    id: empresa.id, nome: empresa.nome, status: empresa.status,
    clone, cloneErro,
  };
}

/**
 * Reclona o catálogo do modelo de origem para dentro de uma empresa JÁ
 * criada — recuperação manual para quando a clonagem automática (feita na
 * criação) falhou, ou nunca rodou (empresas criadas antes desta correção
 * terem o modelo_origem_id gravado sem nunca ter recebido o catálogo).
 *
 * Só roda se a empresa tiver `modelo_origem_id` definido E o catálogo
 * estiver REALMENTE vazio (0 produtos e 0 insumos) — nunca duplica em cima
 * de dado que já existe.
 * @param {import('express').Request} req
 */
export async function clonarModeloParaEmpresa(req, idBruto) {
  const id = v.uuid(idBruto, "Empresa");
  const { data: empresa } = await supabase.from("organizacoes")
    .select("id, nome, modelo_origem_id").eq("id", id).maybeSingle();
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");
  if (!empresa.modelo_origem_id) throw ApiError.badRequest("Esta empresa não tem um modelo inicial definido.");

  const [produtos, insumos] = await Promise.all([
    contar("produtos", (q) => q.eq("organizacao_id", id)),
    contar("insumos", (q) => q.eq("organizacao_id", id)),
  ]);
  if ((produtos ?? 0) > 0 || (insumos ?? 0) > 0) {
    throw ApiError.badRequest(
      "Esta empresa já tem produtos ou insumos cadastrados — clonar de novo duplicaria os dados. " +
      "Apague os registros existentes antes, se quiser recomeçar a partir do modelo.");
  }

  const clone = await clonarCatalogo(supabase, { origemId: empresa.modelo_origem_id, destinoId: id });

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.EMPRESA_MODELO_CLONADO, entidade: "organizacao", entidadeId: id, organizacaoId: id,
    detalhes: { empresa: empresa.nome, modeloOrigemId: empresa.modelo_origem_id, clone },
    ...origemDe(req),
  });

  return { id, clone };
}

/**
 * Confirma que o id informado é de fato uma empresa marcada como Modelo
 * Padrão. `undefined`/vazio é válido (empresa criada sem modelo).
 * @param {unknown} idBruto
 * @returns {Promise<string|null>}
 */
async function validarModeloOrigem(idBruto) {
  const id = v.uuidOpcional(idBruto, "Modelo inicial");
  if (!id) return null;
  const { data } = await supabase.from("organizacoes").select("id, eh_modelo").eq("id", id).maybeSingle();
  if (!data?.eh_modelo) throw ApiError.badRequest("Modelo inicial inválido.");
  return id;
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
 * Contagens de catálogo/histórico/vínculos de uma empresa — mesmo papel de
 * `impactoExclusaoUnidade` (plataforma.unidades.service.js), aplicado no
 * nível de empresa. Alimenta o preview que o painel mostra ANTES do
 * formulário de confirmação: quantas unidades, produtos, insumos, usuários e
 * histórico operacional existem.
 *
 * `exclusaoFisicaSegura` é informativo, não uma trava: quando falso, o
 * painel mostra um aviso forte recomendando arquivar (status "cancelada")
 * em vez de excluir — mas o SuperAdmin ainda pode seguir com "Excluir
 * definitivamente". Quem garante que a exclusão funciona de verdade mesmo
 * havendo catálogo/histórico é `excluir_organizacao_definitivamente`
 * (migration 055): limpa as dependências `on delete restrict` do schema
 * (ficha_tecnica/movimentacoes_estoque/pedidos_compra_itens/vendas_itens/
 * pedidos_compra) antes do delete em cascata, numa única transação. Ver o
 * comentário da migration para a causa raiz completa do erro 23503 que essa
 * função elimina.
 * @param {unknown} idBruto
 */
export async function impactoExclusaoEmpresa(idBruto) {
  const id = v.uuid(idBruto, "Empresa");
  const { data: empresa } = await supabase.from("organizacoes").select("id, nome").eq("id", id).maybeSingle();
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");

  const metricas = await contarVarios([
    { chave: "unidades", tabela: "unidades", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "usuarios", tabela: "usuarios_organizacoes", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "categorias", tabela: "categorias", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "insumos", tabela: "insumos", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "produtos", tabela: "produtos", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "lancamentosDashboardIfood", tabela: "lancamentos_financeiros_diarios", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "bonificacaoLancamentos", tabela: "bonificacao_lancamentos_diarios", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "parserFdImportacoes", tabela: "parser_fd_importacoes", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "martinBrowerIntegracoes", tabela: "martin_brower_integracoes", filtro: (q) => q.eq("organizacao_id", id) },
    { chave: "agenteConversas", tabela: "agente_conversas", filtro: (q) => q.eq("organizacao_id", id) },
  ]);

  // `unidades` e `usuarios` sozinhos não bloqueiam — uma empresa pode ter a
  // Matriz automática (vazia) e ainda assim nunca ter sido usada de verdade;
  // um vínculo de usuário sozinho também não é "operação" (mesmo raciocínio
  // de impactoExclusaoUnidade). O que bloqueia é catálogo (a causa raiz do
  // bug) e histórico operacional real.
  const totalBloqueante = Object.entries(metricas)
    .filter(([chave]) => !["unidades", "usuarios"].includes(chave))
    .reduce((soma, [, valor]) => soma + (valor ?? 0), 0);

  return { id: empresa.id, nome: empresa.nome, metricas, exclusaoFisicaSegura: totalBloqueante === 0 };
}

/**
 * Exclui a empresa DE VERDADE. O botão "Excluir definitivamente" é do
 * SuperAdmin e existe mesmo quando há catálogo/histórico operacional — a
 * trava não pode ser "sem saída" (achado da investigação original: era
 * exatamente esse o bug, ver `impactoExclusaoEmpresa`). O que muda conforme
 * o impacto é o AVISO no painel (arquivar em vez de excluir), não a
 * disponibilidade do botão.
 *
 * A exclusão física em si roda inteira dentro de
 * `excluir_organizacao_definitivamente` (migration 055): uma função
 * PL/pgSQL = uma transação real do Postgres. Ela limpa explicitamente as
 * linhas presas pelas colunas `on delete restrict` do schema
 * (ficha_tecnica/movimentacoes_estoque/pedidos_compra_itens/vendas_itens/
 * pedidos_compra) ANTES do delete em cascata — é isso que resolve o erro
 * 23503 cru que o Postgres devolvia antes. Auditoria e revogação de sessões
 * também estão dentro da função: se qualquer passo falhar, tudo volta atrás
 * junto, nunca sobra um "empresa.excluida" para uma empresa que continua
 * existindo.
 *
 * Exige `confirmacao` igual ao nome exato da empresa. Um clique acidental num
 * painel de administração não pode apagar a operação inteira de um cliente, e
 * um `?confirmar=true` é fácil demais de mandar sem ler — a função SQL
 * confere a MESMA coisa de novo, então a barreira não depende só do backend
 * ter lido certo.
 */
export async function excluirEmpresa(req, idBruto, body) {
  const id = v.uuid(idBruto, "Empresa");
  const confirmacao = typeof body?.confirmacao === "string" ? body.confirmacao.trim() : "";
  const { ip, userAgent } = origemDe(req);

  const { data, error } = await supabase.rpc("excluir_organizacao_definitivamente", {
    p_organizacao_id: id,
    p_confirmacao_nome: confirmacao,
    p_ator_id: req.user.id,
    p_ator_email: req.user.email,
    p_ip: ip,
    p_user_agent: userAgent,
  });
  if (error) {
    if (error.code === "P0002") throw ApiError.notFound(error.message);
    if (error.code === "22023") {
      throw ApiError.badRequest(
        `Exclusão não confirmada. Digite exatamente o nome da empresa para confirmar. ` +
        "Para apenas encerrar sem perder dados, use o status 'cancelada'.");
    }
    throw ApiError.internal(error.message || "Falha ao excluir a empresa.");
  }
  return { id: data.organizacaoId, nome: data.organizacaoNome, excluida: true, ...data };
}

// --------------------------------------------------------------------------
// Módulos (aba "Acessos")
// --------------------------------------------------------------------------

/** Catálogo completo — alimenta o checklist do assistente e da aba Acessos. */
export function catalogoModulos() {
  return CATALOGO_MODULOS;
}

/**
 * Catálogo + quais estão habilitados para uma empresa específica.
 * @param {unknown} idBruto
 */
export async function modulosDaEmpresaAdmin(idBruto) {
  const id = v.uuid(idBruto, "Empresa");
  const habilitados = new Set(await modulosDaEmpresa(id));
  return {
    modulos: CATALOGO_MODULOS.map((m) => ({ ...m, habilitado: habilitados.has(m.id) })),
  };
}

/**
 * Substitui os módulos habilitados de uma empresa. Audita CADA módulo que
 * mudou (um registro por módulo, não um único "módulos alterados") porque é
 * assim que o SuperAdmin quer ler a trilha depois: "habilitou Bonificação
 * Mensal", "removeu Dashboard iFood" — não um blob de ids.
 *
 * Revoga as sessões vivas da empresa, igual a `alterarStatusEmpresa`: a
 * mudança de acesso tem que valer na hora, não só na próxima expiração.
 * @param {import('express').Request} req
 */
export async function definirModulosEmpresaAdmin(req, idBruto, body) {
  const id = v.uuid(idBruto, "Empresa");
  const moduloIds = validarModulos(body?.modulos ?? []);

  const { data: empresa } = await supabase.from("organizacoes").select("id, nome").eq("id", id).maybeSingle();
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");

  const { habilitados, desabilitados } = await definirModulosEmpresa(id, moduloIds, req.user.id);

  const origem = origemDe(req);
  for (const moduloId of habilitados) {
    await auditar({
      atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
      acao: ACOES.EMPRESA_MODULO_HABILITADO, entidade: "organizacao", entidadeId: id, organizacaoId: id,
      detalhes: { empresa: empresa.nome, modulo: moduloId, moduloNome: rotuloModulo(moduloId) },
      ...origem,
    });
  }
  for (const moduloId of desabilitados) {
    await auditar({
      atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
      acao: ACOES.EMPRESA_MODULO_DESABILITADO, entidade: "organizacao", entidadeId: id, organizacaoId: id,
      detalhes: { empresa: empresa.nome, modulo: moduloId, moduloNome: rotuloModulo(moduloId) },
      ...origem,
    });
  }

  let sessoesRevogadas = 0;
  if (habilitados.length || desabilitados.length) {
    sessoesRevogadas = await revogarSessoes({ organizacaoId: id, motivo: "modulos_alterados" });
  }

  return { id, modulos: moduloIds, habilitados, desabilitados, sessoesRevogadas };
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
  // O bypass de impersonação em `requireModulo` já libera qualquer módulo
  // para o superadmin em suporte; carregar os módulos reais da empresa aqui
  // é só para manter o formato da sessão consistente com o de um login normal.
  const modulos = await modulosDaEmpresa(id);
  const { ip, userAgent } = origemDe(req);

  const sessao = await criarSessao({
    usuarioId: req.user.id,
    organizacaoId: id,
    unidadeId: null,
    papel,
    permissoes,
    modulos,
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
    modulos,
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
