// Context Token — o único lugar de onde o backend aceita saber "qual empresa".
//
// POR QUE ELE EXISTE
//   Antes, o cliente mandava `x-organizacao-id` e o backend revalidava o
//   vínculo a cada requisição. Funcionava, mas o frontend ainda ESCOLHIA o id
//   a cada chamada. O requisito é mais forte: não deve haver como "trocar" o
//   company_id pelo frontend. Então o id passa a vir de um token que só o
//   servidor sabe assinar.
//
// COMO FUNCIONA
//   1. o usuário autentica no Supabase (Access Token) — isso diz QUEM ele é;
//   2. ele escolhe a empresa; o backend valida o vínculo e EMITE este token —
//      isso diz ONDE ele está;
//   3. toda requisição de tenant manda os dois. A empresa vem daqui, sempre.
//
// O QUE O TOKEN NÃO É
//   Ele não é a fonte da verdade sobre permissões. O payload traz `role`/`perms`
//   por conveniência de log, mas o middleware relê a linha de `sessoes_contexto`
//   pelo `sid` a cada requisição. Assim, revogar uma sessão (logout forçado,
//   troca de unidade, bloqueio da empresa) tem efeito imediato, sem esperar a
//   expiração — e um token vazado morre com a linha.
//
// Formato: base64url(payload JSON) + "." + base64url(HMAC-SHA256). Sem
// dependência externa: `node:crypto` já dá conta, e menos dependência em
// caminho de autenticação é menos superfície de ataque.

import crypto from "node:crypto";
import { config } from "../config/env.js";

/**
 * Versão do formato do payload. Muda se o conteúdo do token mudar.
 *
 * v1 -> v2 (Fase D do multi-perfil): payload ganha `pid` (perfil operacional).
 * Tokens v1 são REJEITADOS por `verificarContextToken` ("desatualizado" -> 409)
 * — a migration 060 revoga todas as sessões vivas, então não há v1 legítimo
 * circulando depois dela. Não há aceitação simultânea de v1 e v2.
 */
const VERSAO = 2;

/** Validade padrão do token, em segundos (8 h — uma jornada de trabalho). */
export const VALIDADE_PADRAO_S = 8 * 60 * 60;

/**
 * @typedef {object} ContextTokenPayload
 * @property {number} v    versão do formato (2)
 * @property {string} sub  auth.users.id — a CONTA autenticada
 * @property {string} sid  sessoes_contexto.id — a chave para revogação e a AUTORIDADE FINAL
 * @property {string} cid  organizacao_id (company_id)
 * @property {string|null} uid unidade_id, quando o acesso é de uma unidade
 * @property {string|null} pid perfil_id — a PESSOA operacional da sessão.
 *   `null` SOMENTE em impersonação (a linha de `sessoes_contexto` tem
 *   `impersonado_por` setado). Um token normal com `pid` nulo é REJEITADO —
 *   mas essa checagem é feita em `requireContexto` CONTRA A LINHA, não aqui
 *   (structural), porque `null` é estruturalmente legítimo para impersonação.
 * @property {string} role papel_acesso na empresa
 * @property {string[]} perms permissões efetivas
 * @property {string|null} imp superadmin que está "entrando como empresa"
 * @property {number} iat emitido em (epoch segundos)
 * @property {number} exp expira em (epoch segundos)
 */

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function assinar(corpo) {
  return crypto.createHmac("sha256", config.contextTokenSecret).update(corpo).digest();
}

/**
 * Emite um Context Token assinado (v2).
 * @param {object} dados
 * @param {string} dados.usuarioId  auth.users.id — a CONTA
 * @param {string} dados.sessionId
 * @param {string} dados.organizacaoId
 * @param {string|null} [dados.unidadeId]
 * @param {string|null} [dados.perfilId]  perfil operacional; `null` só em impersonação
 * @param {string} dados.papel
 * @param {string[]} [dados.permissoes]
 * @param {string|null} [dados.impersonadoPor]
 * @param {number} [dados.validadeS]
 * @returns {{ token: string, expiraEm: Date }}
 */
export function emitirContextToken({
  usuarioId, sessionId, organizacaoId, unidadeId = null, perfilId = null,
  papel, permissoes = [], impersonadoPor = null, validadeS = VALIDADE_PADRAO_S,
}) {
  const agora = Math.floor(Date.now() / 1000);
  /** @type {ContextTokenPayload} */
  const payload = {
    v: VERSAO,
    sub: usuarioId,
    sid: sessionId,
    cid: organizacaoId,
    uid: unidadeId,
    pid: perfilId,
    role: papel,
    perms: permissoes,
    imp: impersonadoPor,
    iat: agora,
    exp: agora + validadeS,
  };
  const corpo = b64url(JSON.stringify(payload));
  return {
    token: `${corpo}.${b64url(assinar(corpo))}`,
    expiraEm: new Date(payload.exp * 1000),
  };
}

/**
 * Verifica assinatura, versão e expiração de um Context Token.
 * Nunca lança: devolve `{ ok: false, motivo }` para o middleware traduzir em
 * uma resposta HTTP — e o motivo é deliberadamente genérico para o cliente.
 * @param {string|null|undefined} token
 * @returns {{ ok: true, payload: ContextTokenPayload } | { ok: false, motivo: string }}
 */
export function verificarContextToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, motivo: "Token de contexto ausente ou malformado." };
  }

  const corte = token.lastIndexOf(".");
  const corpo = token.slice(0, corte);
  const assinaturaRecebida = token.slice(corte + 1);

  let esperada, recebida;
  try {
    esperada = assinar(corpo);
    recebida = Buffer.from(assinaturaRecebida, "base64url");
  } catch {
    return { ok: false, motivo: "Token de contexto inválido." };
  }

  // Comparação em tempo constante. O teste de tamanho vem antes porque
  // timingSafeEqual lança se os buffers tiverem tamanhos diferentes.
  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return { ok: false, motivo: "Token de contexto inválido." };
  }

  /** @type {ContextTokenPayload} */
  let payload;
  try {
    payload = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
  } catch {
    return { ok: false, motivo: "Token de contexto inválido." };
  }

  if (payload?.v !== VERSAO) return { ok: false, motivo: "Token de contexto desatualizado." };
  if (!payload.sub || !payload.sid || !payload.cid) {
    return { ok: false, motivo: "Token de contexto incompleto." };
  }
  // `pid` NÃO entra no check estrutural: `null` é legítimo para impersonação.
  // A validação forte de `pid` (== `sessoes_contexto.perfil_id`, e `null` só se
  // `impersonado_por` setado) é feita em `requireContexto`, CONTRA A LINHA.
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return { ok: false, motivo: "Contexto expirado. Selecione a unidade novamente." };
  }

  return { ok: true, payload };
}

/**
 * Regra do `pid` (Fase D) — DECISÃO PURA, testável sem banco. Chamada por
 * `requireContexto` depois de localizar a linha de `sessoes_contexto` pelo `sid`.
 *
 * Três verificações, nesta ordem:
 *   1. CRUZAMENTO (igual a `cid`/`uid`): `token.pid` tem de ser EXATAMENTE
 *      `sessoes_contexto.perfil_id` — incluindo `null == null`. Um token com
 *      `pid` forjado (ex.: outro perfil da mesma conta) NÃO passa: o `sid`
 *      (a linha) é a autoridade final.
 *   2. INVARIANTE: `perfil_id` NULL só é legítimo em sessão de IMPERSONAÇÃO
 *      (`impersonado_por` setado). Token normal com `pid` nulo -> rejeitado.
 *   3. PERFIL ATIVO: sessão normal exige que o perfil AINDA esteja ativo
 *      (não confia em snapshot eterno — o perfil pode ter sido desativado
 *      depois da emissão do token).
 *
 * @param {{ tokenPid: string|null|undefined, sessaoPerfilId: string|null, impersonadoPor: string|null, perfilAtivo: boolean|null }} p
 *   `perfilAtivo`: `perfis_operacionais.ativo` da linha (ou `null` quando a
 *   sessão é de impersonação / o perfil não foi encontrado).
 * @returns {{ ok: true, modo: 'normal'|'impersonacao' } | { ok: false, motivo: string }}
 */
export function validarPidContraSessao({ tokenPid, sessaoPerfilId, impersonadoPor, perfilAtivo }) {
  const tPid = tokenPid ?? null;
  const sPid = sessaoPerfilId ?? null;

  if (tPid !== sPid) {
    return { ok: false, motivo: "Contexto divergente. Selecione a unidade novamente." };
  }
  if (sPid === null) {
    if (!impersonadoPor) {
      return { ok: false, motivo: "Contexto inválido. Selecione a unidade novamente." };
    }
    return { ok: true, modo: "impersonacao" };
  }
  if (perfilAtivo !== true) {
    return { ok: false, motivo: "Perfil desativado. Selecione a unidade novamente." };
  }
  return { ok: true, modo: "normal" };
}
