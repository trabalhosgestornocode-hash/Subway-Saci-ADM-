// Sessão de contexto — o que acontece DEPOIS do login.
//
// O login (Supabase Auth) só responde "quem é você". Este módulo responde
// "onde você vai trabalhar": lista as empresas vinculadas, valida a escolha e
// emite o Context Token. Nenhum company_id entra aqui sem passar pela
// verificação de vínculo — e o que o cliente manda é apenas um CANDIDATO.
//
// ---------------------------------------------------------------------------
// REGRA DE ACESSO EFETIVO (empresa -> unidade) — fonte única desta regra;
// todo outro lugar do sistema que decide "quais unidades esta pessoa
// enxerga" (listarUnidadesContexto, o seletor global do topbar, a tela de
// seleção pós-login) só existe porque lê o que `listarAcessos`/
// `selecionarContexto` decidem aqui. Não duplique esta lógica em outro
// arquivo — se um novo lugar precisar dela, chame estas funções.
//
//   podeAcessarUnidade(usuário, unidade) =
//       superadmin (bypass tratado à parte, fora deste módulo — impersonação)
//       OU vínculo ATIVO em usuarios_unidades para aquela unidade
//       OU vínculo ATIVO em usuarios_organizacoes para a organização dona dela
//
// Ou seja: acesso de EMPRESA (usuarios_organizacoes) implica acesso a TODAS
// as unidades ATIVAS dela — as de hoje e as criadas depois — sem precisar
// duplicar uma linha em usuarios_unidades pra cada uma. Nenhum dos dois
// vínculos é pré-requisito do outro: um usuário pode ter só o de unidade
// (sem nunca ter tido acesso de empresa) e isso já basta pra essa unidade
// específica — é o suporte real por trás do comentário em
// plataforma.usuarios.service.js#removerVinculo ("a unidade sozinha também
// autoriza a seleção"), que o `selecionarContexto` antigo não respeitava
// (exigia o vínculo de empresa ATIVO como porta de entrada obrigatória,
// mesmo pra selecionar uma unidade com vínculo direto).
//
// PAPEL EFETIVO: quando os dois vínculos existem para a mesma unidade
// (acesso de empresa + vínculo direto nela), o papel do vínculo DIRETO
// sobrepõe o da empresa quando definido (comportamento pré-existente,
// preservado — não é uma regra nova desta correção).
//
// "Todas as unidades" (unidadeId nulo) é conceitualmente da EMPRESA: exige
// especificamente o vínculo ativo com ela — um vínculo só de unidade nunca
// autoriza o modo consolidado (ver `selecionarContexto`).
// ---------------------------------------------------------------------------

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { emitirContextToken, VALIDADE_PADRAO_S } from "../../shared/contextToken.js";
import { permissoesDoPapel, rotuloPapel } from "../../shared/permissoes.js";
import { modulosDaEmpresa, modulosEfetivosDaUnidade } from "../../shared/modulos.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as v from "../../shared/validar.js";

/** Status de empresa que impedem o tenant de entrar. */
const STATUS_BLOQUEANTES = { bloqueada: "Empresa bloqueada.", suspensa: "Empresa suspensa.", cancelada: "Empresa cancelada." };

/**
 * @typedef {object} OpcaoAcesso
 * @property {string} organizacaoId
 * @property {string} empresaNome
 * @property {string|null} logoUrl
 * @property {string} status
 * @property {string|null} unidadeId
 * @property {string|null} unidadeNome
 * @property {string} papel
 * @property {string} papelRotulo
 * @property {boolean} acessivel
 * @property {string|null} motivo   por que não é acessível
 */

/**
 * Opções de acesso do usuário — o que a tela "Qual unidade deseja acessar?"
 * renderiza, e a mesma fonte que o seletor global do topbar consulta
 * (sessao.service.js#listarUnidadesContexto) para uma empresa específica.
 * Implementa a REGRA DE ACESSO EFETIVO descrita no topo do arquivo.
 *
 * Formato do resultado, por empresa:
 *  * empresa SEM nenhuma unidade cadastrada ainda -> 1 opção consolidada
 *    (unidadeId nulo) — nada pra "expandir".
 *  * empresa com vínculo de EMPRESA e exatamente 1 unidade ativa -> 1 opção,
 *    JÁ apontando pra essa unidade (nunca duas opções — "a empresa" e "a
 *    unidade" — que levariam ao mesmo lugar).
 *  * empresa com vínculo de EMPRESA e 2+ unidades ativas -> TODAS elas,
 *    cada uma sua própria opção (herança — nenhuma precisa de vínculo
 *    direto em usuarios_unidades pra aparecer aqui, nem as criadas depois
 *    desta consulta).
 *  * empresa SEM vínculo de empresa (ativo), só vínculo(s) direto(s) de
 *    unidade -> só essas unidades, nunca as outras da mesma empresa.
 *  * unidade com os DOIS vínculos (empresa + direto) -> aparece uma única
 *    vez, com o papel do vínculo DIRETO quando definido.
 *  * unidade inativa nunca aparece, nem por herança nem por vínculo direto.
 *
 * Empresas bloqueadas/suspensas/canceladas APARECEM, porém desabilitadas e
 * com o motivo. Esconder geraria o pior suporte possível: "minha empresa
 * desapareceu".
 *
 * @param {{usuarioId: string}} params
 * @param {{buscarVinculos: typeof buscarVinculosOrgEUnidade, buscarUnidadesAtivas: typeof buscarUnidadesAtivasDasOrgs, buscarInfoOrganizacoes: typeof buscarInfoDasOrganizacoes}} [deps] injeção para teste (mesmo padrão de cmv.service.js#listarMargensOficialOuComparacao) — sem isto a lógica de herança só seria exercitável contra um Supabase real.
 * @returns {Promise<{superadmin: boolean, opcoes: OpcaoAcesso[]}>}
 */
export async function listarAcessos(
  { usuarioId },
  deps = { buscarVinculos: buscarVinculosOrgEUnidade, buscarUnidadesAtivas: buscarUnidadesAtivasDasOrgs, buscarInfoOrganizacoes: buscarInfoDasOrganizacoes },
) {
  const { superadmin, vinculosOrg, vinculosUni } = await deps.buscarVinculos(usuarioId);

  // Vínculo direto por unidade, agrupado pela empresa DONA dela agora — não
  // pela empresa de quando o vínculo foi criado. É isto que faz uma unidade
  // TRANSFERIDA (migration 053) aparecer sob a empresa nova automaticamente,
  // sem precisar remapear nada aqui: a query já lê o organizacao_id atual.
  const diretoPorOrg = new Map(); // organizacaoId -> Map(unidadeId -> {papel, unidade})
  for (const r of vinculosUni) {
    const u = r.unidades;
    if (!u || !u.ativo) continue; // unidade inativa não conta, nem por vínculo direto
    const mapa = diretoPorOrg.get(u.organizacao_id) ?? new Map();
    mapa.set(u.id, { papel: r.papel, unidade: u });
    diretoPorOrg.set(u.organizacao_id, mapa);
  }

  const papelPorOrg = new Map();  // organizacaoId -> papel (só orgs com vínculo de EMPRESA ativo)
  const infoPorOrg = new Map();   // organizacaoId -> {id, nome, logo_url, status}
  for (const vinculo of vinculosOrg) {
    if (!vinculo.organizacoes) continue;
    papelPorOrg.set(vinculo.organizacao_id, vinculo.papel);
    infoPorOrg.set(vinculo.organizacao_id, vinculo.organizacoes);
  }

  // Empresas a considerar = quem tem vínculo de EMPRESA UNIÃO quem tem pelo
  // menos um vínculo DIRETO de unidade nela — é a união que resolve o
  // "acesso só de unidade, sem nunca ter tido acesso de empresa".
  const organizacaoIds = new Set([...papelPorOrg.keys(), ...diretoPorOrg.keys()]);

  // Empresas com vínculo de EMPRESA herdam TODAS as unidades ATIVAS dela —
  // 1 query só para todas elas (nunca N+1, mesmo com dezenas de empresas).
  const orgsComHeranca = [...papelPorOrg.keys()];
  const unidadesHerdadasPorOrg = new Map();
  if (orgsComHeranca.length) {
    const unidadesData = await deps.buscarUnidadesAtivas(orgsComHeranca);
    for (const u of unidadesData) {
      const lista = unidadesHerdadasPorOrg.get(u.organizacao_id) ?? [];
      lista.push(u);
      unidadesHerdadasPorOrg.set(u.organizacao_id, lista);
    }
  }

  // Empresas que só apareceram por vínculo DIRETO de unidade (sem vínculo de
  // empresa) ainda precisam do nome/logo/status pra montar a opção — busca
  // avulsa, tipicamente pouquíssimas.
  const organizacaoIdsSemInfo = [...organizacaoIds].filter((id) => !infoPorOrg.has(id));
  if (organizacaoIdsSemInfo.length) {
    const orgsData = await deps.buscarInfoOrganizacoes(organizacaoIdsSemInfo);
    for (const org of orgsData) infoPorOrg.set(org.id, org);
  }

  /** @type {OpcaoAcesso[]} */
  const opcoes = [];
  for (const organizacaoId of organizacaoIds) {
    const org = infoPorOrg.get(organizacaoId);
    if (!org) continue; // vínculo órfão (empresa removida) — ignora silenciosamente

    const motivo = STATUS_BLOQUEANTES[org.status] ?? null;
    const base = {
      organizacaoId: org.id,
      empresaNome: org.nome,
      logoUrl: org.logo_url ?? null,
      status: org.status,
      acessivel: !motivo,
      motivo,
    };

    const papelEmpresa = papelPorOrg.get(organizacaoId) ?? null;
    const diretoMapa = diretoPorOrg.get(organizacaoId) ?? new Map();

    if (papelEmpresa) {
      const herdadas = unidadesHerdadasPorOrg.get(organizacaoId) ?? [];
      if (!herdadas.length) {
        // Empresa sem unidade cadastrada ainda — opção consolidada, como sempre.
        opcoes.push({
          ...base, unidadeId: null, unidadeNome: null,
          papel: papelEmpresa, papelRotulo: rotuloPapel(papelEmpresa),
        });
        continue;
      }
      // 1 unidade ou 2+: SEMPRE uma opção por unidade (nunca uma opção
      // "consolidada" a mais quando já existe só 1 lugar pra ir). O papel do
      // vínculo DIRETO nela, se houver, sobrepõe o da empresa.
      for (const u of herdadas) {
        const papel = diretoMapa.get(u.id)?.papel ?? papelEmpresa;
        opcoes.push({
          ...base, unidadeId: u.id, unidadeNome: u.nome, cidade: u.cidade, cnpj: u.cnpj,
          papel, papelRotulo: rotuloPapel(papel),
        });
      }
      continue;
    }

    // Sem vínculo de empresa (ou inativo): só as unidades com vínculo DIRETO
    // autorizam — nunca as outras da mesma empresa.
    for (const { papel, unidade: u } of diretoMapa.values()) {
      if (!papel) continue; // "herda o papel da empresa", mas não há empresa pra herdar — vínculo incompleto, não autoriza sozinho
      opcoes.push({
        ...base, unidadeId: u.id, unidadeNome: u.nome, cidade: u.cidade, cnpj: u.cnpj,
        papel, papelRotulo: rotuloPapel(papel),
      });
    }
  }

  opcoes.sort((a, b) =>
    a.empresaNome.localeCompare(b.empresaNome, "pt-BR") ||
    (a.unidadeNome ?? "").localeCompare(b.unidadeNome ?? "", "pt-BR"));

  return { superadmin, opcoes };
}

/** Busca-padrão (Supabase real) das três fontes de vínculo que `listarAcessos` combina. */
async function buscarVinculosOrgEUnidade(usuarioId) {
  const [superRes, vinculosOrgRes, vinculosUniRes] = await Promise.all([
    supabase.from("plataforma_admins").select("usuario_id")
      .eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle(),
    supabase.from("usuarios_organizacoes")
      .select("papel, organizacao_id, organizacoes(id, nome, logo_url, status)")
      .eq("usuario_id", usuarioId).eq("ativo", true),
    supabase.from("usuarios_unidades")
      .select("papel, unidade_id, unidades(id, nome, organizacao_id, cidade, cnpj, ativo)")
      .eq("usuario_id", usuarioId).eq("ativo", true),
  ]);
  if (vinculosOrgRes.error) throw ApiError.internal(vinculosOrgRes.error.message);
  if (vinculosUniRes.error) throw ApiError.internal(vinculosUniRes.error.message);
  return { superadmin: !!superRes.data, vinculosOrg: vinculosOrgRes.data ?? [], vinculosUni: vinculosUniRes.data ?? [] };
}

/** Busca-padrão das unidades ATIVAS de um conjunto de organizações — a base da herança Empresa -> Unidade em `listarAcessos`. */
async function buscarUnidadesAtivasDasOrgs(organizacaoIds) {
  const { data, error } = await supabase.from("unidades")
    .select("id, nome, organizacao_id, cidade, cnpj")
    .in("organizacao_id", organizacaoIds).eq("ativo", true);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Busca-padrão de dados básicos de organizações (nome/logo/status) — usada quando `listarAcessos` só sabe de uma empresa por vínculo direto de unidade. */
async function buscarInfoDasOrganizacoes(organizacaoIds) {
  const { data, error } = await supabase.from("organizacoes")
    .select("id, nome, logo_url, status").in("id", organizacaoIds);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Acesso efetivo a UMA unidade específica (ver "REGRA DE ACESSO EFETIVO" no
 * topo do arquivo): vínculo ATIVO direto com ela OU vínculo ATIVO com a
 * empresa dona dela — qualquer um dos dois basta. `papelDaEmpresa` vem do
 * chamador (que já consultou `usuarios_organizacoes` de qualquer forma, pra
 * decidir "todas as unidades") — evita uma segunda consulta idêntica.
 *
 * Só valida UMA unidade por vez — de propósito mais simples/direta que
 * `listarAcessos` (que enumera todas de uma vez para a tela inteira); as
 * duas implementam a MESMA regra, cada uma na forma que seu chamador precisa.
 *
 * @param {{usuarioId: string, unidadeId: string, organizacaoId: string, papelDaEmpresa: string|null}} params
 * @returns {Promise<{autorizado: boolean, papel: string|null, unidade: {id: string, nome: string}|null}>}
 */
export async function acessoEfetivoDaUnidade(
  { usuarioId, unidadeId, organizacaoId, papelDaEmpresa },
  deps = { buscarVinculoDireto: buscarVinculoDiretoDaUnidade, buscarUnidade: buscarUnidadePorId },
) {
  const vinculoUni = await deps.buscarVinculoDireto({ usuarioId, unidadeId });

  const unidadeViaVinculoDireto = vinculoUni?.unidades?.organizacao_id === organizacaoId ? vinculoUni.unidades : null;
  const autorizado = papelDaEmpresa != null || !!unidadeViaVinculoDireto;
  if (!autorizado) return { autorizado: false, papel: null, unidade: null };

  // Já temos a unidade (veio junto do vínculo direto) ou precisamos buscar
  // (autorização só pela empresa) — nos dois casos confere ativo/dono antes
  // de aceitar.
  const unidade = unidadeViaVinculoDireto ?? await deps.buscarUnidade(unidadeId);
  if (!unidade || !unidade.ativo || unidade.organizacao_id !== organizacaoId) {
    return { autorizado: false, papel: null, unidade: null };
  }

  // Papel do vínculo DIRETO sobrepõe o da empresa quando definido (regra
  // pré-existente, preservada — não inventada por esta correção).
  const papel = vinculoUni?.papel ?? papelDaEmpresa ?? null;
  return { autorizado: true, papel, unidade: { id: unidade.id, nome: unidade.nome } };
}

/** Busca-padrão do vínculo direto (usuarios_unidades) de `acessoEfetivoDaUnidade`. */
async function buscarVinculoDiretoDaUnidade({ usuarioId, unidadeId }) {
  const { data, error } = await supabase
    .from("usuarios_unidades")
    .select("papel, unidades(id, nome, organizacao_id, ativo)")
    .eq("usuario_id", usuarioId).eq("unidade_id", unidadeId).eq("ativo", true)
    .maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/** Busca-padrão de uma unidade por id, usada por `acessoEfetivoDaUnidade` quando o único caminho de autorização é o vínculo de empresa (sem vínculo direto pra já trazer a unidade junto). */
async function buscarUnidadePorId(unidadeId) {
  const { data, error } = await supabase
    .from("unidades").select("id, nome, organizacao_id, ativo").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Valida a escolha e emite o Context Token.
 *
 * TODA sessão viva anterior do usuário é revogada antes. É o requisito "ao
 * trocar de unidade o Context Token é invalidado e um novo é emitido" — e tem
 * o efeito colateral desejável de o usuário ter um contexto por vez, o que
 * torna "usuários online" e "forçar logout" honestos.
 *
 * @param {object} params
 * @param {{id: string, email: string}} params.usuario
 * @param {unknown} params.organizacaoId  candidato vindo do cliente
 * @param {unknown} params.unidadeId      candidato vindo do cliente
 * @param {string|null} [params.ip]
 * @param {string|null} [params.userAgent]
 * @param {boolean} [params.troca]  true quando é troca de unidade (só p/ auditoria)
 */
export async function selecionarContexto({ usuario, organizacaoId, unidadeId, ip = null, userAgent = null, troca = false }) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const uniId = v.uuidOpcional(unidadeId, "Unidade");

  const negarAcesso = async () => {
    await auditar({
      atorId: usuario.id, atorEmail: usuario.email, acao: ACOES.LOGIN_NEGADO,
      entidade: "organizacao", entidadeId: orgId, organizacaoId: orgId, ip, userAgent,
      detalhes: { motivo: "sem_vinculo" },
    });
    // Mesma mensagem para "empresa/unidade não existe" e "sem vínculo":
    // responder coisas diferentes revelaria o que existe na plataforma.
    throw ApiError.forbidden("Você não tem acesso a esta empresa.");
  };

  // --- vínculo com a EMPRESA (buscado sempre — mesmo pra unidade via
  //     vínculo direto, "empresa bloqueada" tem que valer igual)
  const { data: vinculoOrg, error: eVinculo } = await supabase
    .from("usuarios_organizacoes")
    .select("papel, organizacoes(id, nome, logo_url, status)")
    .eq("usuario_id", usuario.id).eq("organizacao_id", orgId).eq("ativo", true)
    .maybeSingle();
  if (eVinculo) throw ApiError.internal(eVinculo.message);
  const papelDaEmpresa = vinculoOrg?.organizacoes ? vinculoOrg.papel : null;

  let empresa;
  let papel;
  let unidade = null;

  if (!uniId) {
    // "Todas as unidades" é um conceito de EMPRESA — exige especificamente
    // esse vínculo (ver REGRA DE ACESSO EFETIVO no topo do arquivo). Um
    // vínculo só de unidade nunca autoriza o modo consolidado.
    if (!papelDaEmpresa) return negarAcesso();
    empresa = vinculoOrg.organizacoes;
    papel = papelDaEmpresa;
  } else {
    // Acesso efetivo: vínculo de empresa OU vínculo direto com a unidade —
    // é aqui que a herança Empresa -> Unidade passa a valer de verdade
    // (antes, chegar até aqui já exigia vínculo de empresa ATIVO, o que
    // quebrava o acesso de quem só tinha vínculo direto de unidade).
    const acesso = await acessoEfetivoDaUnidade({ usuarioId: usuario.id, unidadeId: uniId, organizacaoId: orgId, papelDaEmpresa });
    if (!acesso.autorizado) return negarAcesso();
    unidade = acesso.unidade;
    papel = acesso.papel;

    empresa = vinculoOrg?.organizacoes ?? null;
    if (!empresa) {
      // Autorizado só pelo vínculo direto (sem vínculo de empresa ativo) —
      // precisamos dos dados da empresa mesmo assim (nome/status/bloqueio).
      const { data, error: eEmpresa } = await supabase
        .from("organizacoes").select("id, nome, logo_url, status").eq("id", orgId).maybeSingle();
      if (eEmpresa) throw ApiError.internal(eEmpresa.message);
      empresa = data;
    }
    if (!empresa) return negarAcesso(); // defensivo: vínculo apontando pra empresa inexistente
  }

  const bloqueio = STATUS_BLOQUEANTES[empresa.status];
  if (bloqueio) throw ApiError.forbidden(`${bloqueio} Fale com o suporte da plataforma.`);
  if (!papel) {
    // Vínculo direto com papel nulo ("herda da empresa") sem nenhum vínculo
    // de empresa pra herdar — configuração incompleta, não meu lugar de
    // adivinhar uma precedência nova. Recusa com uma mensagem que aponta o
    // problema real (não é "sem acesso", é "vínculo mal configurado").
    throw ApiError.forbidden("Não foi possível determinar seu cargo nesta unidade — vínculo incompleto. Fale com o administrador.");
  }

  const permissoes = permissoesDoPapel(papel);
  // Acesso efetivo = módulos da empresa ∩ módulos da unidade (item 4 do
  // pedido de gerenciamento de Unidades) — só faz sentido cruzar quando uma
  // unidade específica foi selecionada; "todas as unidades"/contexto de
  // empresa continua valendo o que a empresa tem, igual sempre foi.
  const modulos = unidade
    ? await modulosEfetivosDaUnidade(orgId, unidade.id)
    : await modulosDaEmpresa(orgId);

  const sessao = await criarSessao({
    usuarioId: usuario.id, organizacaoId: orgId, unidadeId: unidade?.id ?? null,
    papel, permissoes, modulos, impersonadoPor: null, ip, userAgent,
  });

  await auditar({
    atorId: usuario.id, atorEmail: usuario.email,
    acao: troca ? ACOES.CONTEXTO_TROCADO : ACOES.CONTEXTO_SELECIONADO,
    entidade: "organizacao", entidadeId: orgId, organizacaoId: orgId, ip, userAgent,
    detalhes: { papel, unidadeId: unidade?.id ?? null, empresa: empresa.nome },
  });

  return {
    contextToken: sessao.token,
    expiraEm: sessao.expiraEm,
    sessionId: sessao.id,
    empresa: { id: empresa.id, nome: empresa.nome, logoUrl: empresa.logo_url ?? null, status: empresa.status },
    unidade,
    papel,
    papelRotulo: rotuloPapel(papel),
    permissoes,
    modulos,
    impersonando: false,
  };
}

/**
 * Troca de unidade a partir do seletor global do topbar — ou seja, a partir
 * de uma sessão que JÁ TEM contexto (diferente de `selecionarContexto`, que
 * é usado sem contexto prévio: tela de login e tela de seleção). É por isso
 * que existe separado: aqui já se sabe se a sessão atual é uma impersonação,
 * e é exatamente essa informação que muda a regra de autorização:
 *
 *   * impersonação -> continua impersonação. Pode ir para QUALQUER unidade
 *     ativa da MESMA empresa: a confiança que abriu a impersonação (ver
 *     plataforma.empresas.service.js#entrarComoEmpresa) já cobre a empresa
 *     inteira — não é escalação de privilégio, é navegação dentro do mesmo
 *     atendimento de suporte. Sem este caminho, o SuperAdmin em suporte
 *     ficava sem como trocar de unidade a não ser saindo da empresa e
 *     reentrando (o problema relatado no Grupo Saci).
 *   * sessão normal -> delega para `selecionarContexto`, que já faz a
 *     checagem de vínculo de sempre (nada muda aqui pro caso comum).
 *
 * @param {object} params
 * @param {{id: string, email: string}} params.usuario
 * @param {string} params.organizacaoId  da sessão ATUAL (req.tenant), nunca do cliente
 * @param {unknown} params.unidadeId     candidato vindo do cliente
 * @param {boolean} params.impersonando  da sessão ATUAL (req.acesso), nunca do cliente
 * @param {string|null} [params.ip]
 * @param {string|null} [params.userAgent]
 */
export async function trocarUnidadeDoContexto({ usuario, organizacaoId, unidadeId, impersonando, ip = null, userAgent = null }) {
  if (!impersonando) {
    return selecionarContexto({ usuario, organizacaoId, unidadeId, ip, userAgent, troca: true });
  }

  const uniId = v.uuidOpcional(unidadeId, "Unidade");

  const { data: org } = await supabase.from("organizacoes")
    .select("id, nome, logo_url, status").eq("id", organizacaoId).maybeSingle();
  if (!org) throw ApiError.notFound("Empresa não encontrada.");
  const bloqueio = STATUS_BLOQUEANTES[org.status];
  if (bloqueio) throw ApiError.forbidden(`${bloqueio} Fale com o suporte da plataforma.`);

  let unidade = null;
  if (uniId) {
    const { data: u } = await supabase.from("unidades")
      .select("id, nome, organizacao_id, ativo").eq("id", uniId).maybeSingle();
    if (!u || u.organizacao_id !== organizacaoId || !u.ativo) {
      throw ApiError.forbidden("Esta unidade não pertence à empresa em suporte.");
    }
    unidade = { id: u.id, nome: u.nome };
  }

  const papel = "organization_admin";
  const permissoes = permissoesDoPapel(papel);
  const modulos = unidade
    ? await modulosEfetivosDaUnidade(organizacaoId, unidade.id)
    : await modulosDaEmpresa(organizacaoId);

  const sessao = await criarSessao({
    usuarioId: usuario.id, organizacaoId, unidadeId: unidade?.id ?? null,
    papel, permissoes, modulos, impersonadoPor: usuario.id, ip, userAgent,
    validadeS: 60 * 60,
  });

  await auditar({
    atorId: usuario.id, atorEmail: usuario.email, atorTipo: "superadmin",
    acao: ACOES.CONTEXTO_TROCADO, entidade: "organizacao", entidadeId: organizacaoId, organizacaoId,
    impersonadoPor: usuario.id,
    detalhes: { unidadeId: unidade?.id ?? null, empresa: org.nome },
    ip, userAgent,
  });

  return {
    contextToken: sessao.token,
    expiraEm: sessao.expiraEm,
    sessionId: sessao.id,
    empresa: { id: org.id, nome: org.nome, logoUrl: org.logo_url ?? null, status: org.status },
    unidade,
    papel,
    papelRotulo: rotuloPapel(papel),
    permissoes,
    modulos,
    impersonando: true,
  };
}

/**
 * Cria a linha em `sessoes_contexto` e emite o token correspondente.
 * Compartilhado com a impersonação do SuperAdmin — por isso é exportado.
 *
 * A ordem importa: a linha nasce ANTES do token existir. Se a emissão falhasse
 * depois de um token já circulando, haveria token sem lastro; assim, o pior
 * caso é uma linha órfã que ninguém consegue usar.
 *
 * @param {object} params
 * @param {string} params.usuarioId
 * @param {string} params.organizacaoId
 * @param {string|null} params.unidadeId
 * @param {string} params.papel
 * @param {string[]} params.permissoes
 * @param {string[]} [params.modulos]
 * @param {string|null} params.impersonadoPor
 * @param {string|null} [params.ip]
 * @param {string|null} [params.userAgent]
 * @param {number} [params.validadeS]
 */
export async function criarSessao({
  usuarioId, organizacaoId, unidadeId, papel, permissoes, modulos = [],
  impersonadoPor = null, ip = null, userAgent = null, validadeS = VALIDADE_PADRAO_S,
}) {
  await revogarSessoes({ usuarioId, motivo: impersonadoPor ? "impersonacao" : "novo_contexto" });

  const expiraEm = new Date(Date.now() + validadeS * 1000);
  const { data: linha, error } = await supabase
    .from("sessoes_contexto")
    .insert({
      usuario_id: usuarioId,
      organizacao_id: organizacaoId,
      unidade_id: unidadeId,
      papel,
      permissoes,
      modulos,
      impersonado_por: impersonadoPor,
      ip, user_agent: userAgent,
      expira_em: expiraEm.toISOString(),
    })
    .select("id")
    .single();
  if (error || !linha) throw ApiError.internal("Não foi possível abrir a sessão de contexto.");

  // Módulos não entram no payload assinado do token (diferente de `permissoes`,
  // que entra por hoje, cosmeticamente): `requireContexto` sempre relê
  // `sessoes_contexto.modulos`, então carregar no token não teria uso.
  const { token } = emitirContextToken({
    usuarioId, sessionId: linha.id, organizacaoId, unidadeId,
    papel, permissoes, impersonadoPor, validadeS,
  });

  return { id: linha.id, token, expiraEm: expiraEm.toISOString() };
}

/**
 * Revoga as sessões vivas de um usuário (ou uma específica).
 * É o mecanismo por trás de: trocar unidade, sair, forçar logout, bloquear
 * usuário, trocar o papel de um vínculo e alterar módulos/status de uma
 * unidade (`unidadeId` — revoga só as sessões PRESAS àquela unidade, sem
 * derrubar o resto da empresa).
 * @param {{usuarioId?: string, sessionId?: string, organizacaoId?: string, unidadeId?: string, motivo?: string}} filtro
 * @returns {Promise<number>} quantas sessões foram revogadas
 */
export async function revogarSessoes({ usuarioId, sessionId, organizacaoId, unidadeId, motivo = "revogada" }) {
  if (!usuarioId && !sessionId && !organizacaoId && !unidadeId) return 0;

  let q = supabase.from("sessoes_contexto")
    .update({ revogada_em: new Date().toISOString(), motivo_revogacao: motivo })
    .is("revogada_em", null);

  if (sessionId) q = q.eq("id", sessionId);
  if (usuarioId) q = q.eq("usuario_id", usuarioId);
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  if (unidadeId) q = q.eq("unidade_id", unidadeId);

  const { data, error } = await q.select("id");
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).length;
}

/**
 * Encerra o contexto atual. Se era uma impersonação, a auditoria registra o
 * fim dela — o par "iniciada/encerrada" é o que dá a duração do acesso de
 * suporte a um ambiente de cliente.
 * @param {{usuario: {id: string, email: string}, acesso?: any, ip?: string|null, userAgent?: string|null}} params
 */
export async function encerrarContexto({ usuario, acesso = null, ip = null, userAgent = null }) {
  const revogadas = await revogarSessoes({ usuarioId: usuario.id, motivo: "encerrada_pelo_usuario" });

  if (acesso?.impersonando) {
    await auditar({
      atorId: acesso.impersonadoPor, atorEmail: usuario.email, atorTipo: "superadmin",
      acao: ACOES.IMPERSONAR_FIM, entidade: "organizacao", entidadeId: acesso.empresa?.id,
      organizacaoId: acesso.empresa?.id, impersonadoPor: acesso.impersonadoPor, ip, userAgent,
      detalhes: { empresa: acesso.empresa?.nome },
    });
  } else {
    await auditar({
      atorId: usuario.id, atorEmail: usuario.email, acao: ACOES.LOGOUT,
      organizacaoId: acesso?.empresa?.id ?? null, ip, userAgent,
      detalhes: { sessoes_revogadas: revogadas },
    });
  }
  return { revogadas };
}

/**
 * Define a nova senha do próprio usuário e apaga a flag `senha_provisoria`.
 *
 * Não exige a senha atual: o Access Token já é a prova de identidade, e o
 * usuário acabou de autenticar com a provisória (é o fluxo do primeiro acesso).
 * Reproduz o padrão do próprio Supabase, cujo `updateUser({ password })` do
 * lado do cliente também confia no token da sessão.
 *
 * @param {object} params
 * @param {{id: string, email: string, senhaProvisoria?: boolean}} params.usuario
 * @param {unknown} params.senha
 * @param {string|null} [params.ip]
 * @param {string|null} [params.userAgent]
 */
export async function definirNovaSenha({ usuario, senha, ip = null, userAgent = null }) {
  const nova = v.senha(senha); // 8..72 caracteres

  const { error } = await supabase.auth.admin.updateUserById(usuario.id, { password: nova });
  if (error) {
    // A mensagem mais comum aqui é "nova senha igual à anterior".
    const m = (error.message || "").toLowerCase();
    if (m.includes("different from the old") || m.includes("same as the")) {
      throw ApiError.badRequest("A nova senha precisa ser diferente da atual.");
    }
    throw ApiError.badRequest(error.message || "Não foi possível definir a senha.");
  }

  // Baixa a flag: a partir da próxima requisição, o gate `exigirSenhaDefinitiva`
  // deixa de bloquear (o requireAuth relê `perfis` a cada requisição).
  const { error: pe } = await supabase.from("perfis")
    .update({ senha_provisoria: false }).eq("id", usuario.id);
  if (pe) throw ApiError.internal("Senha alterada, mas falhou ao concluir a liberação. Recarregue e tente de novo.");

  await auditar({
    atorId: usuario.id, atorEmail: usuario.email, atorTipo: "usuario",
    acao: ACOES.SENHA_DEFINIDA, entidade: "usuario", entidadeId: usuario.id,
    ip, userAgent,
    detalhes: { primeiroAcesso: usuario.senhaProvisoria === true },
  });

  return { ok: true, senhaProvisoria: false };
}

/** Unidades ativas de uma organização, para o modo impersonação de `listarUnidadesContexto`. */
async function buscarUnidadesAtivasDaOrg(organizacaoId) {
  const { data, error } = await supabase
    .from("unidades")
    .select("id, nome, cidade")
    .eq("organizacao_id", organizacaoId).eq("ativo", true)
    .order("nome");
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Unidades da EMPRESA DO CONTEXTO ATUAL que a sessão pode escolher no
 * seletor global do topbar (Fase G — corrige o "contexto sem saída": empresa
 * com várias unidades, `unidadeId` nulo, e nenhum jeito visível de escolher
 * uma). Propositalmente DIFERENTE de `listarAcessos`:
 *
 *   * `listarAcessos` é o snapshot de login (todas as empresas do usuário) —
 *     só é buscado nos pontos de entrada (login, F5 quando ainda não há
 *     contexto), nunca depois de restaurar sessão ou de uma impersonação.
 *     Reaproveitar aquele snapshot para o chip do topbar é exatamente o que
 *     deixava o seletor vazio/desabilitado num F5 ou numa entrada via
 *     impersonação — o dado nunca tinha sido buscado.
 *   * esta função é chamada toda vez que `mostrarApp()` monta o shell do
 *     tenant (login, F5, troca de unidade E impersonação), sempre escopada à
 *     empresa do Context Token vigente.
 *
 * Impersonação (suporte do SuperAdmin) não nasce de um vínculo pessoal — por
 * isso enxerga TODAS as unidades ativas da empresa, o mesmo bypass que
 * `pode()`/`temModulo()` já aplicam. Sessão normal usa a mesma regra de
 * autorização de `listarAcessos` (vínculo em `usuarios_unidades`), só
 * filtrada para a empresa do contexto atual — nunca confia em nada vindo do
 * cliente.
 *
 * @param {{usuarioId: string, organizacaoId: string, impersonando: boolean}} params
 * @param {{buscarUnidadesAtivas: typeof buscarUnidadesAtivasDaOrg, listarAcessos: typeof listarAcessos}} [deps] injeção para teste (mesmo padrão de cmv.service.js#listarMargensOficialOuComparacao).
 */
export async function listarUnidadesContexto(
  { usuarioId, organizacaoId, impersonando },
  deps = { buscarUnidadesAtivas: buscarUnidadesAtivasDaOrg, listarAcessos },
) {
  if (impersonando) {
    const unidades = await deps.buscarUnidadesAtivas(organizacaoId);
    return { modo: "impersonacao", unidades };
  }

  const { opcoes } = await deps.listarAcessos({ usuarioId });
  const unidades = opcoes
    .filter((o) => o.organizacaoId === organizacaoId && o.acessivel && o.unidadeId)
    .map((o) => ({ id: o.unidadeId, nome: o.unidadeNome, cidade: o.cidade ?? null }));
  return { modo: "vinculo", unidades };
}

/**
 * Contexto atual, já resolvido pelo middleware. Serve para o frontend
 * reconstruir a UI após um recarregamento de página sem perguntar de novo.
 * @param {{acesso: any, tenant: any}} req
 */
export function contextoAtual(req) {
  return {
    empresa: req.acesso.empresa,
    unidade: req.acesso.unidade,
    papel: req.acesso.papel,
    papelRotulo: rotuloPapel(req.acesso.papel),
    permissoes: req.acesso.permissoes,
    modulos: req.acesso.modulos,
    impersonando: req.acesso.impersonando,
    organizacaoId: req.tenant.organizacaoId,
    unidadeId: req.tenant.unidadeId,
  };
}
