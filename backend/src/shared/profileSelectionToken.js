// Profile Selection Token — a PROVA, verificável server-side, de que o PIN de
// um perfil operacional foi validado (Fase H).
//
// A AMEAÇA QUE RESOLVE
//   A conta "Operacional X" tem e-mail+senha compartilhados e 2 perfis
//   (Fulana 1, Fulana 2). Quem conhece a credencial da conta NÃO pode assumir
//   qualquer perfil. Sem esta prova, um cliente malicioso ignoraria a tela do
//   PIN e chamaria `POST /sessao/selecionar { perfilId: <Fulana 2> }` direto.
//   Um boolean no frontend / localStorage / `pinValidado: true` no corpo seria
//   trivialmente forjável. Esta prova é HMAC-assinada por um segredo que só o
//   servidor conhece.
//
// TRÊS TOKENS, TRÊS PAPÉIS — NÃO CONFUNDIR
//   JWT do Supabase          -> autentica a CONTA (e-mail+senha).
//   Profile Selection Token  -> ESTE. Prova temporária de que o PIN do PERFIL
//                               passou. Curtíssima duração. Só aceito em
//                               `POST /sessao/selecionar`.
//   Context Token (v2)       -> a sessão operacional completa (perfil + empresa
//                               + unidade + papel + permissões). Emitido SÓ
//                               depois que empresa/unidade foram escolhidas.
//
//   Segredo PRÓPRIO (`config.profileSelectionSecret`, derivação distinta da do
//   Context Token) + campo `purpose` obrigatório => um Context Token NUNCA
//   verifica como selection token e vice-versa (token confusion barrado por
//   chave E por propósito).
//
// FORMATO: base64url(payload JSON) + "." + base64url(HMAC-SHA256)  — idêntico
// ao Context Token (shared/contextToken.js), de propósito: mesmo código de
// verificação, mesma robustez, zero dependência nova.

import crypto from "node:crypto";
import { config } from "../config/env.js";

/** Versão do formato do payload. Independente da versão do Context Token. */
const VERSAO = 1;
/** Propósito — validado na verificação. Barra token confusion. */
const PROPOSITO = "profile_selection";
/**
 * Validade: 5 minutos. Tempo de sobra para o usuário escolher empresa/unidade
 * logo após o PIN; curto o bastante para um token vazado ter janela mínima.
 * Expirou -> informa o PIN de novo. (Fase H, ponto 5.)
 */
export const VALIDADE_S = 5 * 60;

/**
 * @typedef {object} ProfileSelectionPayload
 * @property {number} v        versão do formato (1)
 * @property {'profile_selection'} purpose
 * @property {string} acc      a CONTA (auth.users.id / req.user.id) — a prova é
 *   inútil para outra conta.
 * @property {string} pid      o PERFIL exato que passou pelo PIN.
 * @property {string} jti      nonce aleatório — identifica a prova (uso único:
 *   consumido em `sessoes_contexto.selecao_nonce`, ver migration 064).
 * @property {number} iat
 * @property {number} exp
 */

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function assinar(corpo) {
  return crypto.createHmac("sha256", config.profileSelectionSecret).update(corpo).digest();
}

/**
 * Emite a prova. Chamada por `selecionarPerfil` APÓS o PIN correto (ou, para
 * conta de 1 perfil, sem PIN — ver Fase H, ponto 20).
 * @param {{ contaId: string, perfilId: string, validadeS?: number }} dados
 * @returns {{ token: string, nonce: string, expiraEm: Date }}
 */
export function emitirProfileSelectionToken({ contaId, perfilId, validadeS = VALIDADE_S }) {
  const agora = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  /** @type {ProfileSelectionPayload} */
  const payload = {
    v: VERSAO,
    purpose: PROPOSITO,
    acc: contaId,
    pid: perfilId,
    jti: nonce,
    iat: agora,
    exp: agora + validadeS,
  };
  const corpo = b64url(JSON.stringify(payload));
  return {
    token: `${corpo}.${b64url(assinar(corpo))}`,
    nonce,
    expiraEm: new Date(payload.exp * 1000),
  };
}

/**
 * Verifica assinatura, versão, propósito e expiração. Nunca lança: devolve
 * `{ ok: false, motivo }` para o chamador traduzir. O motivo é genérico.
 *
 * NÃO valida `acc`/`pid` contra a requisição — isso é responsabilidade de
 * `resolverPerfilParaContexto` (compara `acc` com `req.user.id`, confirma que
 * `pid` é um perfil ATIVO da conta, e — se o corpo também trouxe `perfilId` —
 * exige `perfilId === pid`).
 * @param {string|null|undefined} token
 * @returns {{ ok: true, payload: ProfileSelectionPayload } | { ok: false, motivo: string }}
 */
export function verificarProfileSelectionToken(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, motivo: "Prova de seleção ausente ou malformada. Informe o PIN novamente." };
  }
  const corte = token.lastIndexOf(".");
  const corpo = token.slice(0, corte);
  const assinaturaRecebida = token.slice(corte + 1);

  let esperada;
  let recebida;
  try {
    esperada = assinar(corpo);
    recebida = Buffer.from(assinaturaRecebida, "base64url");
  } catch {
    return { ok: false, motivo: "Prova de seleção inválida. Informe o PIN novamente." };
  }
  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return { ok: false, motivo: "Prova de seleção inválida. Informe o PIN novamente." };
  }

  /** @type {ProfileSelectionPayload} */
  let payload;
  try {
    payload = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
  } catch {
    return { ok: false, motivo: "Prova de seleção inválida. Informe o PIN novamente." };
  }

  if (payload?.v !== VERSAO) return { ok: false, motivo: "Prova de seleção desatualizada. Informe o PIN novamente." };
  if (payload.purpose !== PROPOSITO) return { ok: false, motivo: "Prova de seleção inválida. Informe o PIN novamente." };
  if (!payload.acc || !payload.pid || !payload.jti) {
    return { ok: false, motivo: "Prova de seleção incompleta. Informe o PIN novamente." };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return { ok: false, motivo: "Prova de seleção expirada. Informe o PIN novamente." };
  }
  return { ok: true, payload };
}

export const PROFILE_SELECTION_META = Object.freeze({ versao: VERSAO, purpose: PROPOSITO, validadeS: VALIDADE_S });
