// Autenticação e autorização da plataforma.
//
// SÃO DUAS PERGUNTAS DIFERENTES, E AGORA SÃO DOIS MIDDLEWARES DIFERENTES:
//
//   requireAuth       -> QUEM é você?  (Access Token do Supabase)
//   requireContexto   -> ONDE você está? (Context Token assinado por nós)
//
// Essa separação é o que permite o SuperAdmin existir sem pertencer a empresa
// alguma: o painel da plataforma passa por requireAuth + requireSuperadmin e
// NUNCA por requireContexto — logo, não tem `req.tenant`, não tem company_id,
// não tem como "vazar" para dentro de um tenant sem passar pela impersonação
// auditada.
//
// MUDANÇA DE SEGURANÇA IMPORTANTE (era assim antes, não é mais):
//   O company_id vinha de `perfis.organizacao_id` ou dos headers
//   x-organizacao-id / x-unidade-id, revalidados a cada requisição. Esses
//   headers FORAM REMOVIDOS. Hoje a empresa vem só do Context Token, e nem o
//   token é confiado por si: ele carrega um `sid` e o poder real está na linha
//   de `sessoes_contexto`, relida a cada requisição. Assim, revogar uma sessão
//   (logout forçado, troca de unidade, bloqueio da empresa) vale na hora.

import { supabase } from "../config/supabase.js";
import { config } from "../config/env.js";
import { ApiError } from "../shared/ApiError.js";
import { verificarContextToken, validarPidContraSessao } from "../shared/contextToken.js";
import { temPermissao } from "../shared/permissoes.js";
import { rotuloModulo } from "../shared/modulos.js";

/** Nome do header que transporta o Context Token. */
export const HEADER_CONTEXTO = "x-context-token";

/** Status de empresa que impedem o uso do sistema pelos usuários do tenant. */
const STATUS_BLOQUEANTES = new Set(["bloqueada", "suspensa", "cancelada"]);

/**
 * @typedef {object} UsuarioAutenticado
 * @property {string} id
 * @property {string} email
 * @property {string} nome
 * @property {boolean} superadmin
 * @property {boolean} painelAdministrativo
 * @property {boolean} ativo
 * @property {boolean} senhaProvisoria
 */

/**
 * @typedef {object} AcessoContexto
 * @property {string} sessionId
 * @property {string|null} perfilId  perfil operacional da sessão; null em impersonação
 * @property {string} papel
 * @property {string[]} permissoes
 * @property {string[]} modulos
 * @property {string|null} impersonadoPor
 * @property {boolean} impersonando
 * @property {{id: string, nome: string, status: string}} empresa
 * @property {{id: string, nome: string}|null} unidade
 */

// ---------------------------------------------------------------------------
// 1. QUEM É VOCÊ — Access Token do Supabase
// ---------------------------------------------------------------------------

/**
 * Valida o JWT do Supabase e carrega a IDENTIDADE do usuário. Não resolve
 * empresa alguma: identidade e contexto são coisas separadas agora.
 *
 * `perfis` aqui é só nome/ativo (identidade). As colunas organizacao_id/papel
 * dessa tabela são legado e NÃO são lidas para autorizar nada.
 */
export async function requireAuth(req, _res, next) {
  try {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return next(ApiError.unauthorized("Token de acesso ausente."));

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return next(ApiError.unauthorized("Sessão inválida ou expirada."));

    const usuarioId = data.user.id;

    // Identidade + papéis GLOBAIS de plataforma, em paralelo. Os dois papéis
    // globais são independentes entre si e dos vínculos de empresa/unidade:
    //   - `plataforma_admins`               -> SuperAdmin (técnico)
    //   - `painel_administrativo_usuarios`  -> Painel Administrativo (gerencial)
    // Ambos são relidos a cada request — revogar qualquer um vale na hora.
    const [perfilRes, superRes, painelAdmRes] = await Promise.all([
      supabase.from("perfis").select("id, nome, email, ativo, senha_provisoria").eq("id", usuarioId).maybeSingle(),
      supabase.from("plataforma_admins").select("usuario_id")
        .eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle(),
      supabase.from("painel_administrativo_usuarios").select("usuario_id")
        .eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle(),
    ]);

    const perfil = perfilRes.data;
    // Sem linha em `perfis` o usuário ainda é autenticável: a identidade vem do
    // Auth. Isso é intencional — uma conta recém-criada pelo SuperAdmin não
    // pode ficar impedida de logar por causa de uma tabela de apoio. O que ela
    // não terá é CONTEXTO (nenhuma empresa), e o front trata esse caso.
    if (perfil && perfil.ativo === false) {
      return next(ApiError.forbidden("Usuário inativo. Contate o administrador."));
    }

    /** @type {UsuarioAutenticado} */
    req.user = {
      id: usuarioId,
      email: data.user.email ?? perfil?.email ?? "",
      nome: perfil?.nome || data.user.user_metadata?.nome || (data.user.email ?? "").split("@")[0],
      superadmin: !!superRes.data,
      // Acesso GLOBAL ao Painel Administrativo (monitoramento gerencial
      // cross-tenant). NÃO implica SuperAdmin — ver requirePainelAdministrativo.
      painelAdministrativo: !!painelAdmRes.data,
      ativo: perfil?.ativo ?? true,
      // Senha definida por um administrador: o usuário precisa trocá-la antes de
      // usar o sistema. O gate `exigirSenhaDefinitiva` faz valer isso.
      senhaProvisoria: perfil?.senha_provisoria === true,
    };
    next();
  } catch {
    next(ApiError.unauthorized("Falha ao autenticar."));
  }
}

// ---------------------------------------------------------------------------
// 2. ONDE VOCÊ ESTÁ — Context Token assinado
// ---------------------------------------------------------------------------

/**
 * Resolve o tenant da requisição a partir do Context Token. Deve vir SEMPRE
 * depois de requireAuth.
 *
 * Preenche `req.tenant = { organizacaoId, unidadeId }` — a mesma forma que os
 * módulos já consomem, então nenhum service precisou mudar. A diferença é a
 * procedência: agora é impossível o frontend informar outra empresa.
 */
export async function requireContexto(req, _res, next) {
  try {
    const verificacao = verificarContextToken(req.header(HEADER_CONTEXTO));
    if (!verificacao.ok) return next(erroContexto(verificacao.motivo));
    const p = verificacao.payload;

    // O token é do usuário autenticado? Sem isto, um token válido de OUTRA
    // pessoa passaria — é o pareamento entre as duas credenciais.
    if (p.sub !== req.user.id) {
      return next(erroContexto("Contexto não pertence a esta sessão."));
    }

    // A sessão ainda vale? Esta é a leitura que torna a revogação instantânea.
    const COLS_SESSAO = "id, usuario_id, organizacao_id, unidade_id, papel, permissoes, modulos, impersonado_por, expira_em, revogada_em";
    let { data: sessao, error } = await supabase
      .from("sessoes_contexto")
      .select(`${COLS_SESSAO}, perfil_id`)
      .eq("id", p.sid)
      .maybeSingle();
    // Pré-060: coluna `perfil_id` ainda não existe. Relê sem ela e trata a
    // requisição como LEGADA (sem camada de perfil) — comportamento idêntico
    // ao de antes da Fase D. A regra do `pid` não se aplica: não há perfil
    // para forjar. Some assim que 060 rodar (1 reseleção na janela).
    let semColunaPerfil = false;
    if (error && /perfil_id|does not exist|schema cache|could not find/i.test(error.message || "")) {
      semColunaPerfil = true;
      ({ data: sessao, error } = await supabase.from("sessoes_contexto").select(COLS_SESSAO).eq("id", p.sid).maybeSingle());
      if (sessao) sessao.perfil_id = null;
    }

    if (error) return next(ApiError.internal("Falha ao validar o contexto."));
    if (!sessao) return next(erroContexto("Contexto não encontrado. Selecione a unidade novamente."));
    if (sessao.usuario_id !== req.user.id) return next(erroContexto("Contexto inválido."));
    if (sessao.revogada_em) return next(erroContexto("Contexto encerrado. Selecione a unidade novamente."));
    if (new Date(sessao.expira_em).getTime() <= Date.now()) {
      return next(erroContexto("Contexto expirado. Selecione a unidade novamente."));
    }

    // O token diz uma coisa e a sessão diz outra? Assinatura comprometida ou
    // token antigo reaproveitado. Recusa — a sessão é a verdade.
    if (sessao.organizacao_id !== p.cid || (sessao.unidade_id ?? null) !== (p.uid ?? null)) {
      return next(erroContexto("Contexto divergente. Selecione a unidade novamente."));
    }

    // PERFIL (Context Token v2) — buscado em paralelo com a empresa. Só quando a
    // sessão é normal (perfil_id setado); em impersonação `perfil_id` é NULL.
    const [{ data: empresa }, perfilRow] = await Promise.all([
      supabase.from("organizacoes").select("id, nome, status, ativo").eq("id", sessao.organizacao_id).maybeSingle(),
      sessao.perfil_id
        ? supabase.from("perfis_operacionais").select("id, nome, ativo").eq("id", sessao.perfil_id).maybeSingle().then((r) => r.data ?? null)
        : Promise.resolve(null),
    ]);

    // Regra do `pid` — cruzamento contra a linha + invariante de impersonação +
    // perfil ainda ativo (ver contextToken.js#validarPidContraSessao). Um token
    // com `pid` forjado (outro perfil da mesma conta) NÃO passa aqui. Pulada
    // apenas na janela pré-060 (sem coluna = sem camada de perfil).
    if (!semColunaPerfil) {
      const pid = validarPidContraSessao({
        tokenPid: p.pid,
        sessaoPerfilId: sessao.perfil_id ?? null,
        impersonadoPor: sessao.impersonado_por ?? null,
        perfilAtivo: perfilRow ? perfilRow.ativo : null,
      });
      if (!pid.ok) return next(erroContexto(pid.motivo));
    }

    // Empresa bloqueada/suspensa derruba o acesso na hora, sem esperar o token
    // vencer. O superadmin em impersonação passa — é justamente quando ele
    // precisa entrar para resolver o motivo do bloqueio.
    if (!empresa) return next(erroContexto("Empresa não encontrada."));
    if (STATUS_BLOQUEANTES.has(empresa.status) && !sessao.impersonado_por) {
      return next(ApiError.forbidden(`Acesso indisponível: empresa ${rotuloStatus(empresa.status)}.`));
    }

    let unidade = null;
    if (sessao.unidade_id) {
      const { data: u } = await supabase
        .from("unidades").select("id, nome").eq("id", sessao.unidade_id).maybeSingle();
      unidade = u ? { id: u.id, nome: u.nome } : null;
    }

    /** @type {{organizacaoId: string, unidadeId: string|null}} */
    req.tenant = { organizacaoId: sessao.organizacao_id, unidadeId: sessao.unidade_id ?? null };

    /**
     * Identidade OPERACIONAL da sessão. `null` em impersonação (o superadmin
     * age como ele mesmo num contexto de cliente, sem perfil). Nunca confia no
     * nome vindo do token — vem da linha real de `perfis_operacionais`.
     * @type {{ id: string, nome: string|null }|null}
     */
    req.perfil = sessao.perfil_id
      ? { id: sessao.perfil_id, nome: perfilRow?.nome ?? null }
      : null;

    /** @type {AcessoContexto} */
    req.acesso = {
      sessionId: sessao.id,
      perfilId: sessao.perfil_id ?? null,
      papel: sessao.papel,
      permissoes: Array.isArray(sessao.permissoes) ? sessao.permissoes : [],
      modulos: Array.isArray(sessao.modulos) ? sessao.modulos : [],
      impersonadoPor: sessao.impersonado_por ?? null,
      impersonando: !!sessao.impersonado_por,
      empresa: { id: empresa.id, nome: empresa.nome, status: empresa.status },
      unidade,
    };

    // Heartbeat da sessão: alimenta "usuários online" e permite expirar
    // sessões ociosas. Deliberadamente sem await — a latência do usuário não
    // deve pagar por telemetria, e perder um heartbeat não tem consequência.
    tocarSessao(sessao.id);

    next();
  } catch {
    next(ApiError.unauthorized("Falha ao resolver o contexto."));
  }
}

/**
 * Contexto inválido/ausente sai como 409, não 401.
 *
 * A distinção importa para o frontend: 401 significa "faça login de novo";
 * 409 significa "seu login está bom, escolha a unidade de novo". Se ambos
 * fossem 401, qualquer troca de unidade expirada expulsaria o usuário do
 * sistema inteiro.
 * @param {string} motivo
 */
function erroContexto(motivo) {
  return new ApiError(409, motivo, { contexto: "invalido" });
}

/** @param {string} status */
function rotuloStatus(status) {
  return { bloqueada: "bloqueada", suspensa: "suspensa", cancelada: "cancelada" }[status] ?? status;
}

/** Atualiza ultimo_uso_em sem bloquear a requisição. @param {string} sessionId */
function tocarSessao(sessionId) {
  supabase.from("sessoes_contexto")
    .update({ ultimo_uso_em: new Date().toISOString() })
    .eq("id", sessionId)
    .then(({ error }) => { if (error) console.error("[sessao] heartbeat falhou:", error.message); },
          (e) => console.error("[sessao] heartbeat falhou:", e?.message));
}

// ---------------------------------------------------------------------------
// 3. SENHA PROVISÓRIA — troca obrigatória no primeiro acesso
// ---------------------------------------------------------------------------

/**
 * Gate: enquanto a senha for provisória, NADA da API funciona além de trocá-la.
 *
 * Por que no servidor e não só na tela: se o bloqueio vivesse apenas no
 * frontend, bastaria chamar a API direto para contornar a troca. Aqui a regra
 * é real — o token de acesso não serve para operar o sistema até a senha ser
 * redefinida. As únicas exceções são `/me` (o front precisa LER a flag) e as
 * rotas de sessão que dão saída/troca de senha, liberadas antes deste gate em
 * app.js e no router de sessão.
 *
 * Responde 403 com `{ senhaProvisoria: true }` para o front reagir mesmo que
 * uma chamada escape pela borda.
 */
export function exigirSenhaDefinitiva(req, _res, next) {
  if (req.user?.senhaProvisoria) {
    return next(new ApiError(403, "Defina uma nova senha para continuar.", { senhaProvisoria: true }));
  }
  next();
}

// ---------------------------------------------------------------------------
// 4. AUTORIZAÇÃO
// ---------------------------------------------------------------------------

/**
 * Restringe a rota ao SuperAdmin da plataforma. Não olha `req.tenant` — e é
 * exatamente esse o ponto: o painel da plataforma não tem empresa.
 */
export function requireSuperadmin(req, _res, next) {
  if (!req.user?.superadmin) {
    return next(ApiError.forbidden("Ação restrita ao SuperAdmin da plataforma."));
  }
  next();
}

/**
 * Restringe a rota ao PAINEL ADMINISTRATIVO da Crescer — o ambiente GERENCIAL
 * de monitoramento cross-tenant. Não olha `req.tenant` (o painel não tem
 * empresa), igual a `requireSuperadmin`.
 *
 * O SuperAdmin passa por BYPASS: ele já administra tudo, e o painel é uma
 * visão a menos, não a mais. Quem não é SuperAdmin precisa do flag próprio em
 * `painel_administrativo_usuarios` (carregado por requireAuth, relido a cada
 * request — revogar surte efeito na hora). Ter esse flag NÃO concede nenhum
 * poder de SuperAdmin (empresas/unidades/usuários/módulos/impersonação).
 */
export function requirePainelAdministrativo(req, _res, next) {
  if (req.user?.superadmin || req.user?.painelAdministrativo) return next();
  return next(ApiError.forbidden("Acesso restrito ao Painel Administrativo da Crescer."));
}

/**
 * Exige uma permissão do contexto atual. Use depois de requireContexto.
 *
 * O superadmin em impersonação passa por qualquer permissão: ele entrou para
 * dar suporte, e a rastreabilidade disso é a auditoria (que grava
 * `impersonado_por` em cada ação), não um bloqueio de permissão.
 * @param {string} permissao
 */
export function requirePermissao(permissao) {
  return (req, _res, next) => {
    if (!req.acesso) return next(ApiError.forbidden("Contexto de empresa não definido."));
    if (req.acesso.impersonando) return next();
    if (!temPermissao(req.acesso.permissoes, permissao)) {
      return next(ApiError.forbidden("Permissão insuficiente para esta ação."));
    }
    next();
  };
}

/**
 * Exige que a empresa do contexto atual tenha o módulo contratado.
 *
 * Mesma regra de bypass de `requirePermissao`: o superadmin em impersonação
 * passa por qualquer módulo — ele entrou para dar suporte, e travá-lo no
 * mesmo pacote que a empresa comprou impediria justamente o tipo de
 * diagnóstico para o qual a impersonação existe. A rastreabilidade é a
 * auditoria (`impersonado_por` em cada ação), não um bloqueio aqui.
 * @param {string} moduloId
 */
export function requireModulo(moduloId) {
  return (req, _res, next) => {
    if (!req.acesso) return next(ApiError.forbidden("Contexto de empresa não definido."));
    if (req.acesso.impersonando) return next();
    if (!req.acesso.modulos.includes(moduloId)) {
      return next(ApiError.forbidden(`Módulo "${rotuloModulo(moduloId)}" não contratado por esta empresa.`));
    }
    next();
  };
}

/**
 * Exige QUALQUER um dos papéis de vínculo informados.
 * Preferir `requirePermissao` — o papel é mais grosseiro e mais frágil a
 * mudanças de nomenclatura. Existe para regras que são de fato "por cargo".
 * @param {...string} papeis
 */
export function requirePapel(...papeis) {
  return (req, _res, next) => {
    if (!req.acesso) return next(ApiError.forbidden("Contexto de empresa não definido."));
    if (req.acesso.impersonando) return next();
    if (!papeis.includes(req.acesso.papel)) {
      return next(ApiError.forbidden("Permissão insuficiente para esta ação."));
    }
    next();
  };
}

/** Janela (ms) que define "online" para o Dashboard Global. */
export const JANELA_ONLINE_MS = config.janelaOnlineMin * 60 * 1000;
