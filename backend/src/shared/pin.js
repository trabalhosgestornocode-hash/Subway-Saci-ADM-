// PIN do PERFIL operacional — hashing e verificação (Fase H).
//
// O QUE É
//   Autenticação SECUNDÁRIA da PESSOA. NÃO é a senha da conta: não vive no
//   Supabase Auth, não autentica sozinho, não troca e-mail/senha. Só serve
//   para provar "sou eu, a Fulana 2" DEPOIS que a credencial da conta
//   (e-mail+senha compartilhados) já autenticou. Guardado em
//   `perfis_operacionais.pin_hash`.
//
// POR QUE scrypt (e não bcrypt/argon2)
//   O projeto NÃO tem bcrypt/argon2 instalados e já usa `crypto.scryptSync`
//   para derivar a chave de cifra do iFood (shared/cripto.js). scrypt é um KDF
//   de senha adequado (memory-hard), está no core do Node (zero dependência
//   nova em caminho de autenticação — menos superfície) e é o padrão já
//   adotado aqui. Usamos a variante ASSÍNCRONA (`crypto.scrypt`) para não
//   bloquear o event loop na validação.
//
// FORMATO DO HASH (`pin_hash`)
//   "s1:<N>:<r>:<p>:<keylen>:<saltB64url>:<hashB64url>"
//   * s1        -> versão do esquema (permite rotação de parâmetros sem ambiguidade);
//   * N,r,p     -> parâmetros do scrypt GRAVADOS no próprio hash (um hash antigo
//                  continua verificável mesmo se os defaults mudarem depois);
//   * keylen    -> tamanho da chave derivada em bytes;
//   * salt      -> 16 bytes aleatórios POR PIN (nunca fixo — dois perfis com o
//                  mesmo PIN produzem hashes diferentes; ver Fase H, ponto 51);
//   * hash      -> a chave derivada.
//
// BAIXA ENTROPIA
//   Um PIN de 4–6 dígitos tem no máximo 1e6 combinações — hashing sozinho NÃO
//   basta. A proteção real é o LOCKOUT por perfil (`pin_tentativas` /
//   `pin_bloqueado_ate`), aplicado em perfil.service.js#validarPinParaSelecao.
//
// NUNCA logue o PIN, o `pin_hash`, nem o corpo da requisição que os carrega.

import crypto from "node:crypto";
import { promisify } from "node:util";
import { ApiError } from "./ApiError.js";

const scrypt = promisify(crypto.scrypt);

const VERSAO = "s1";
// N=2^15 (32768) é o mínimo recomendado atual para scrypt interativo; r=8, p=1
// são os valores canônicos. Custo ~30–60 ms por verificação — imperceptível
// para o usuário, caro o suficiente para brute force somado ao lockout.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 };
const SALT_BYTES = 16;
// `maxmem` do scrypt precisa acomodar 128 * N * r bytes (+ folga).
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 3;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const deB64u = (s) => Buffer.from(s, "base64url");

/** Só dígitos, 4 a 6 posições. */
const RE_PIN = /^\d{4,6}$/;

/**
 * Valida o FORMATO do PIN (não verifica contra hash). Lança ApiError.badRequest
 * no padrão do projeto. Rejeita: vazio, não-string, não-numérico, tamanho fora
 * de 4–6. NÃO rejeita sequências fracas (0000, 1234) — decisão da Fase H
 * (ponto 13): o lockout é a proteção; proibir padrões dá pouco ganho e irrita.
 * @param {unknown} pin
 * @returns {string} o PIN normalizado (string de dígitos)
 */
export function validarFormatoPin(pin) {
  const s = typeof pin === "number" ? String(pin) : pin;
  if (typeof s !== "string" || !RE_PIN.test(s)) {
    throw ApiError.badRequest("O PIN deve ter de 4 a 6 dígitos numéricos.");
  }
  return s;
}

/**
 * Gera o hash de um PIN. O PIN em texto puro NUNCA sai desta função nem é
 * gravado em lugar nenhum.
 * @param {string} pin  já validado por `validarFormatoPin`
 * @returns {Promise<string>} string no formato "s1:N:r:p:keylen:salt:hash"
 */
export async function hashPin(pin) {
  const pinOk = validarFormatoPin(pin);
  const salt = crypto.randomBytes(SALT_BYTES);
  const { N, r, p, keylen } = PARAMS;
  const derived = await scrypt(pinOk, salt, keylen, { N, r, p, maxmem: MAXMEM });
  return [VERSAO, N, r, p, keylen, b64u(salt), b64u(derived)].join(":");
}

/**
 * Verifica um PIN contra um hash gravado. Comparação em tempo constante.
 * Um `hashArmazenado` malformado/nulo devolve `false` (nunca lança 500) —
 * quem chama trata "perfil sem PIN" antes.
 * @param {string} pin
 * @param {string|null|undefined} hashArmazenado
 * @returns {Promise<boolean>}
 */
export async function verificarPin(pin, hashArmazenado) {
  if (typeof pin !== "string" || typeof hashArmazenado !== "string") return false;
  const partes = hashArmazenado.split(":");
  if (partes.length !== 7 || partes[0] !== VERSAO) return false;

  const N = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  const keylen = Number(partes[4]);
  if (![N, r, p, keylen].every((n) => Number.isInteger(n) && n > 0)) return false;

  let salt;
  let esperado;
  try {
    salt = deB64u(partes[5]);
    esperado = deB64u(partes[6]);
  } catch {
    return false;
  }
  if (esperado.length !== keylen) return false;

  let derived;
  try {
    derived = await scrypt(pin, salt, keylen, { N, r, p, maxmem: 128 * N * r * 3 });
  } catch {
    return false;
  }
  return derived.length === esperado.length && crypto.timingSafeEqual(derived, esperado);
}

/** Parâmetros efetivos — para o relatório/testes. Não expõe segredo nenhum. */
export const PIN_PARAMS = Object.freeze({ versao: VERSAO, ...PARAMS });
