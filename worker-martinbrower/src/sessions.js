// Sessões efêmeras do worker.
//
// TUDO EM MEMÓRIA, SEM EXCEÇÃO. Não há banco, Redis, arquivo nem volume.
// Credencial, código 2FA, JWT do portal e cookies existem apenas dentro do
// processo e do browser context, e morrem junto com a sessão.
//
// CONSEQUÊNCIA ACEITA: o Cloud Run pode reciclar a instância a qualquer
// momento. Quando isso acontece a sessão some, e o backend recebe
// MARTIN_BROWER_REMOTE_SESSION_LOST — o usuário reinicia. Persistir a sessão
// resolveria isso ao custo de gravar credenciais em algum lugar, que é
// exatamente o que a política proíbe.

import { randomBytes } from "node:crypto";
import { erro, CODIGOS } from "./errors.js";
import { log } from "./logsafe.js";

export const TTL_TOTAL_MS = Number(process.env.MB_SESSION_TTL_MS ?? 600_000);   // 10 min
export const TTL_AGUARDANDO_2FA_MS = Number(process.env.MB_2FA_TTL_MS ?? 300_000); // 5 min
export const TTL_INATIVIDADE_MS = Number(process.env.MB_IDLE_TTL_MS ?? 180_000);   // 3 min
export const MAX_SESSOES = Number(process.env.MB_MAX_SESSOES ?? 1);   // concurrency=1
export const MAX_TENTATIVAS_LOGIN = 3;
export const MAX_TENTATIVAS_2FA = 3;

export const STATUS = {
  INICIANDO: "iniciando",
  AUTENTICANDO: "autenticando",
  AGUARDANDO_CODIGO: "aguardando_codigo",
  AUTENTICADO: "autenticado",
  COLETANDO: "coletando",
  CONCLUIDA: "concluida",
  ERRO: "erro",
  CANCELADA: "cancelada",
  EXPIRADA: "expirada",
};

const FINAIS = new Set([STATUS.CONCLUIDA, STATUS.ERRO, STATUS.CANCELADA, STATUS.EXPIRADA]);

const sessoes = new Map();

/** Uma sincronização por unidade — segunda barreira além do lock do backend. */
function unidadeOcupada(unidadeId) {
  for (const s of sessoes.values()) {
    if (s.unidadeId === unidadeId && !FINAIS.has(s.status)) return true;
  }
  return false;
}

export function criarSessao({ organizationId, unidadeId, userId, clientId, credenciais }) {
  if (unidadeOcupada(unidadeId)) throw erro(CODIGOS.CONFLITO, `unidade ${unidadeId} ja em sincronizacao`);
  if (sessoes.size >= MAX_SESSOES) throw erro(CODIGOS.CONFLITO, `teto de ${MAX_SESSOES} sessao(oes) atingido`);

  const agora = Date.now();
  const sessao = {
    remoteSessionId: randomBytes(24).toString("base64url"),
    organizationId, unidadeId, userId, clientId,
    status: STATUS.INICIANDO,
    etapa: null,
    createdAt: agora,
    lastActivityAt: agora,
    expiresAt: agora + TTL_TOTAL_MS,
    tentativasLogin: 0,
    tentativas2FA: 0,
    abortController: new AbortController(),
    // Recursos do Playwright — nunca serializados.
    browser: null,
    browserContext: null,
    page: null,
    // Zona sensível.
    _credenciais: credenciais,   // { usuario, senha } — some após o submit
    _codigo2fa: null,
  };

  sessoes.set(sessao.remoteSessionId, sessao);
  log("info", "sessao.criada", {
    remoteSessionId: sessao.remoteSessionId,
    organizationId, unidadeId, userId,
  });
  return sessao;
}

/**
 * Busca VALIDANDO o dono. O backend envia organizationId/unidadeId/userId em
 * toda chamada; a sessão só responde a quem a criou.
 * @throws SESSAO_PERDIDA quando não existe (instância reciclada) ou expirou
 */
export function obterSessao(id, { organizationId, unidadeId, userId } = {}) {
  const s = sessoes.get(id);
  if (!s) throw erro(CODIGOS.SESSAO_PERDIDA, "sessao inexistente nesta instancia");

  if ((organizationId && s.organizationId !== organizationId)
   || (unidadeId && s.unidadeId !== unidadeId)
   || (userId && s.userId !== userId)) {
    // Mesmo erro de "não existe": não confirmamos que o id é válido para
    // outro tenant.
    throw erro(CODIGOS.SESSAO_PERDIDA, "sessao nao pertence a este tenant/usuario");
  }

  const agora = Date.now();
  if (agora > s.expiresAt) { expirar(s, "ttl total"); throw erro(CODIGOS.SESSAO_EXPIRADA, "ttl total"); }

  // O TTL de inatividade não corre enquanto esperamos o humano digitar o 2FA:
  // ali vale o TTL específico de 2FA.
  const limiteInatividade = s.status === STATUS.AGUARDANDO_CODIGO
    ? TTL_AGUARDANDO_2FA_MS
    : TTL_INATIVIDADE_MS;
  if (agora - s.lastActivityAt > limiteInatividade) {
    expirar(s, s.status === STATUS.AGUARDANDO_CODIGO ? "espera de 2FA" : "inatividade");
    throw erro(CODIGOS.SESSAO_EXPIRADA, "inatividade");
  }

  s.lastActivityAt = agora;
  return s;
}

export function atualizar(sessao, { status, etapa } = {}) {
  if (status) sessao.status = status;
  if (etapa !== undefined) sessao.etapa = etapa;
  sessao.lastActivityAt = Date.now();
}

export function registrarTentativaLogin(sessao) {
  sessao.tentativasLogin += 1;
  if (sessao.tentativasLogin > MAX_TENTATIVAS_LOGIN) throw erro(CODIGOS.AUTH_FAILED, "tentativas de login esgotadas");
}

export function informarCodigo2fa(sessao, codigo) {
  sessao.tentativas2FA += 1;
  if (sessao.tentativas2FA > MAX_TENTATIVAS_2FA) throw erro(CODIGOS.DOIS_FA_INVALIDO, "tentativas de 2FA esgotadas");
  sessao._codigo2fa = codigo;
  sessao.lastActivityAt = Date.now();
}

/**
 * Descarta a senha assim que ela foi digitada no formulário. A partir daí a
 * autenticação vive no browser context (cookies), e manter a senha em memória
 * só aumentaria a janela de exposição.
 */
export function descartarSenha(sessao) {
  if (sessao._credenciais) {
    sessao._credenciais.senha = null;
    sessao._credenciais.usuario = null;
    sessao._credenciais = null;
  }
}

function expirar(sessao, motivo) {
  if (!FINAIS.has(sessao.status)) sessao.status = STATUS.EXPIRADA;
  log("warn", "sessao.expirada", { remoteSessionId: sessao.remoteSessionId, motivo });
  encerrar(sessao.remoteSessionId).catch(() => {});
}

/**
 * Encerramento definitivo. IDEMPOTENTE — pode ser chamado quantas vezes for.
 * Destrói o browser context e apaga todo segredo. É o único lugar que remove
 * a sessão do mapa.
 */
export async function encerrar(id, statusFinal) {
  const s = sessoes.get(id);
  if (!s) return;

  if (statusFinal) s.status = statusFinal;
  else if (!FINAIS.has(s.status)) s.status = STATUS.CANCELADA;

  s.abortController.abort();
  descartarSenha(s);
  s._codigo2fa = null;

  // Ordem importa: page -> context -> browser. Fechar o browser antes deixaria
  // handles pendurados.
  for (const [rotulo, recurso] of [["page", s.page], ["context", s.browserContext], ["browser", s.browser]]) {
    try { await recurso?.close(); }
    catch (e) { log("warn", "sessao.falha_ao_fechar", { recurso: rotulo, erro: e.message }); }
  }
  s.page = null; s.browserContext = null; s.browser = null;

  sessoes.delete(id);
  log("info", "sessao.encerrada", {
    remoteSessionId: id, status: s.status,
    duracaoMs: Date.now() - s.createdAt,
  });
}

/** Projeção para o backend. Nenhum segredo e nenhum detalhe do Playwright. */
export function paraBackend(sessao) {
  return {
    remoteSessionId: sessao.remoteSessionId,
    status: sessao.status,
    etapa: sessao.etapa,
    aguardandoCodigo: sessao.status === STATUS.AGUARDANDO_CODIGO,
    expiresAt: new Date(sessao.expiresAt).toISOString(),
    tentativasLogin: sessao.tentativasLogin,
    tentativas2FA: sessao.tentativas2FA,
  };
}

export const sessoesAtivas = () => sessoes.size;

/** Encerra tudo — usado em SIGTERM/SIGINT. */
export async function encerrarTodas(motivo) {
  const ids = [...sessoes.keys()];
  if (ids.length) log("warn", "sessoes.encerrando_todas", { quantidade: ids.length, motivo });
  await Promise.allSettled(ids.map((id) => encerrar(id, STATUS.CANCELADA)));
}

// Varredura: sessão órfã (ex.: worker travou no meio) não segura o Chromium.
const varredura = setInterval(() => {
  const agora = Date.now();
  for (const s of [...sessoes.values()]) {
    const limite = s.status === STATUS.AGUARDANDO_CODIGO ? TTL_AGUARDANDO_2FA_MS : TTL_INATIVIDADE_MS;
    if (agora > s.expiresAt || agora - s.lastActivityAt > limite) expirar(s, "varredura");
  }
}, 30_000);
varredura.unref?.();

export function _resetar() { sessoes.clear(); }
