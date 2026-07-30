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

/** Versão do formato do payload. Muda se o conteúdo do token mudar. */
const VERSAO = 1;

/** Validade padrão do token, em segundos (8 h — uma jornada de trabalho). */
export const VALIDADE_PADRAO_S = 8 * 60 * 60;

/**
 * @typedef {object} ContextTokenPayload
 * @property {number} v    versão do formato
 * @property {string} sub  auth.users.id do usuário
 * @property {string} sid  sessoes_contexto.id — a chave para revogação
 * @property {string} cid  organizacao_id (company_id)
 * @property {string|null} uid unidade_id, quando o acesso é de uma unidade
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
 * Emite um Context Token assinado.
 * @param {object} dados
 * @param {string} dados.usuarioId
 * @param {string} dados.sessionId
 * @param {string} dados.organizacaoId
 * @param {string|null} [dados.unidadeId]
 * @param {string} dados.papel
 * @param {string[]} [dados.permissoes]
 * @param {string|null} [dados.impersonadoPor]
 * @param {number} [dados.validadeS]
 * @returns {{ token: string, expiraEm: Date }}
 */
export function emitirContextToken({
  usuarioId, sessionId, organizacaoId, unidadeId = null,
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
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return { ok: false, motivo: "Contexto expirado. Selecione a unidade novamente." };
  }

  return { ok: true, payload };
}
