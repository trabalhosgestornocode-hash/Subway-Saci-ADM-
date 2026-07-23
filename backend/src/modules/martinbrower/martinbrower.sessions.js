// Sessões temporárias e locks da sincronização Martin Brower.
//
// POLÍTICA DE CREDENCIAIS (decisão desta fase, documentada de propósito):
//   "Credenciais efêmeras, mantidas exclusivamente em memória do processo e
//    descartadas ao final de cada sincronização."
//
// Consequências que este arquivo IMPÕE:
//   * usuário, senha e código 2FA existem só dentro de um objeto em memória;
//   * NADA disso vai para Supabase, arquivo, log, localStorage ou variável
//     de ambiente;
//   * a sessão morre por conclusão, cancelamento, erro OU expiração (10 min),
//     e a limpeza roda sempre — inclusive no caminho de erro;
//   * `descartar()` sobrescreve os campos antes de soltar a referência.
//
// LIMITAÇÃO CONHECIDA: memória de processo não é compartilhada entre
// instâncias. Isto funciona com instância única (o caso hoje no Render). Se
// um dia houver mais de uma réplica, o sessionId precisa ir para um Redis —
// e AINDA ASSIM sem credencial dentro, só o estado da máquina.

import { randomUUID, randomBytes } from "node:crypto";
import { MB_SESSAO, MB_STATUS, MB_STATUS_FINAIS } from "./martinbrower.constants.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";
import { mbLog } from "./martinbrower.logsafe.js";

const sessoes = new Map();  // sessionId -> sessão
const locks = new Map();    // chaveLock -> { sessionId, expiraEm }

const chaveLock = (organizacaoId, unidadeId, clientId) => `${organizacaoId}:${unidadeId}:${clientId}`;

// --- lock por organização + unidade + clientId ----------------------------

export function adquirirLock({ organizacaoId, unidadeId, clientId, sessionId }) {
  const chave = chaveLock(organizacaoId, unidadeId, clientId);
  const atual = locks.get(chave);
  // TTL no lock é essencial: o Render Free hiberna e reinicia sem avisar.
  // Sem isso, um processo morto deixaria a loja travada para sempre.
  if (atual && atual.expiraEm > Date.now()) throw mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CONFLICT);
  locks.set(chave, { sessionId, expiraEm: Date.now() + MB_SESSAO.lockTtlMs });
  return chave;
}

export function liberarLock(chave, sessionId) {
  const atual = locks.get(chave);
  // Só o dono libera — evita que um cancelamento tardio derrube o lock de
  // uma sincronização nova que já começou.
  if (atual && (!sessionId || atual.sessionId === sessionId)) locks.delete(chave);
}

export function lockAtivo({ organizacaoId, unidadeId, clientId }) {
  const atual = locks.get(chaveLock(organizacaoId, unidadeId, clientId));
  return atual && atual.expiraEm > Date.now() ? atual : null;
}

// --- sessões --------------------------------------------------------------

/**
 * Cria a sessão temporária. As credenciais entram aqui e NÃO saem: nenhum
 * getter público as expõe, e `paraCliente()` nunca as inclui.
 */
export function criarSessao({ organizacaoId, unidadeId, clientId, usuarioId, credenciais, sincronizacaoId }) {
  const sessionId = randomBytes(24).toString("base64url"); // aleatório, não sequencial
  const agora = Date.now();

  const sessao = {
    sessionId,
    // Vínculo com quem pode consultá-la. Outro usuário recebe 404, não 403 —
    // não confirmamos nem que o sessionId existe.
    usuarioId, organizacaoId, unidadeId, clientId,
    sincronizacaoId: sincronizacaoId ?? randomUUID(),
    status: MB_STATUS.AGUARDANDO,
    etapa: null,
    criadaEm: agora,
    expiraEm: agora + MB_SESSAO.ttlMs,
    tentativasLogin: 0,
    tentativas2fa: 0,
    resultado: null,
    erro: null,
    // --- zona sensível: só o worker toca, nunca serializada ---
    _credenciais: credenciais ?? null,   // { usuario, senha } | null
    _codigo2fa: null,
    _controle: new AbortController(),    // cancelamento cooperativo
  };

  sessoes.set(sessionId, sessao);
  // Rede de segurança: mesmo que ninguém chame finalizar(), a sessão morre.
  sessao._timer = setTimeout(() => expirarSessao(sessionId), MB_SESSAO.ttlMs);
  sessao._timer.unref?.();

  mbLog("info", "sessao.criada", { sessionId, organizacaoId, unidadeId, usuarioId });
  return sessao;
}

/** Busca a sessão VALIDANDO dono, organização e unidade. Nunca só pelo id. */
export function obterSessao({ sessionId, usuarioId, organizacaoId, unidadeId }) {
  const s = sessoes.get(sessionId);
  if (!s) return null;
  if (s.usuarioId !== usuarioId) return null;
  if (s.organizacaoId !== organizacaoId) return null;
  if (unidadeId && s.unidadeId !== unidadeId) return null;
  if (s.expiraEm <= Date.now()) { expirarSessao(sessionId); return null; }
  return s;
}

export function atualizarSessao(sessao, { status, etapa, resultado, erro }) {
  if (!sessao) return;
  if (status) sessao.status = status;
  if (etapa !== undefined) sessao.etapa = etapa;
  if (resultado !== undefined) sessao.resultado = resultado;
  if (erro !== undefined) sessao.erro = erro;
}

export function registrarTentativaLogin(sessao) {
  sessao.tentativasLogin += 1;
  if (sessao.tentativasLogin > MB_SESSAO.maxTentativasLogin) {
    finalizarSessao(sessao.sessionId, MB_STATUS.ERRO);
    throw mbErro(MB_ERROS.MARTIN_BROWER_AUTH_FAILED);
  }
}

export function informarCodigo2fa(sessao, codigo) {
  sessao.tentativas2fa += 1;
  if (sessao.tentativas2fa > MB_SESSAO.maxTentativas2fa) {
    finalizarSessao(sessao.sessionId, MB_STATUS.ERRO);
    throw mbErro(MB_ERROS.MARTIN_BROWER_2FA_INVALID);
  }
  sessao._codigo2fa = codigo;   // some em descartar()
  return sessao;
}

export function cancelarSessao(sessao) {
  sessao._controle?.abort();
  atualizarSessao(sessao, { status: MB_STATUS.CANCELADO, etapa: "Cancelado pelo usuário" });
  finalizarSessao(sessao.sessionId, MB_STATUS.CANCELADO);
}

function expirarSessao(sessionId) {
  const s = sessoes.get(sessionId);
  if (!s) return;
  if (!MB_STATUS_FINAIS.has(s.status)) s.status = MB_STATUS.EXPIRADO;
  s._controle?.abort();
  finalizarSessao(sessionId, s.status);
}

/**
 * Encerramento definitivo. DEVE ser chamado em bloco finally por quem
 * orquestra a sincronização — este é o ponto único que apaga os segredos.
 */
export function finalizarSessao(sessionId, statusFinal) {
  const s = sessoes.get(sessionId);
  if (!s) return;
  clearTimeout(s._timer);
  if (statusFinal) s.status = statusFinal;
  descartarSegredos(s);
  // Guarda o resultado por um instante para o último polling do frontend,
  // já sem nenhum segredo dentro.
  const restos = setTimeout(() => sessoes.delete(sessionId), 60_000);
  restos.unref?.();
  mbLog("info", "sessao.finalizada", { sessionId, status: s.status });
}

// Sobrescreve antes de soltar a referência.
function descartarSegredos(s) {
  if (s._credenciais) {
    s._credenciais.usuario = null;
    s._credenciais.senha = null;
    s._credenciais = null;
  }
  s._codigo2fa = null;
}

/**
 * Projeção segura para o frontend. É a ÚNICA forma de a sessão sair do
 * backend — e por construção não há como um segredo escapar por aqui.
 */
export function paraCliente(sessao) {
  if (!sessao) return null;
  return {
    sessionId: sessao.sessionId,
    status: sessao.status,
    etapa: sessao.etapa,
    aguardandoCodigo: sessao.status === MB_STATUS.AGUARDANDO_CODIGO,
    expiraEm: new Date(sessao.expiraEm).toISOString(),
    resultado: sessao.resultado,
    erro: sessao.erro ? { codigo: sessao.erro.codigo, mensagem: sessao.erro.mensagem } : null,
  };
}

// Varredura periódica: sessões órfãs não sobrevivem a um worker que travou.
const varredura = setInterval(() => {
  const agora = Date.now();
  for (const [id, s] of sessoes) if (s.expiraEm <= agora) expirarSessao(id);
  for (const [k, l] of locks) if (l.expiraEm <= agora) locks.delete(k);
}, 60_000);
varredura.unref?.();

// Apenas para teste: limpa o estado global entre casos.
export function _resetarEstado() { sessoes.clear(); locks.clear(); }
