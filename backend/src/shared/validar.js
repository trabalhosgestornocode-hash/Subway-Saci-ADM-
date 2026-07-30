// Validadores de entrada — a "tipagem forte" em tempo de execução.
//
// O projeto é JavaScript puro por decisão de arquitetura (sem build step). O
// JSDoc dá a tipagem para o editor; estes helpers dão a garantia em runtime,
// que é a que importa numa fronteira HTTP. Toda rota nova valida o corpo aqui
// antes de tocar no banco, e o erro sai como 400 com mensagem em pt-BR.
//
// Convenção: cada função devolve o valor JÁ NORMALIZADO (trim, lowercase,
// Number) ou lança ApiError.badRequest. Sufixo `Opcional` = aceita ausente
// e devolve o default.

import { ApiError } from "./ApiError.js";

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberadamente permissiva: validação real de e-mail é o envio. Só barra
// o que é obviamente inválido.
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const vazio = (v) => v === undefined || v === null || v === "";

/**
 * @param {unknown} v
 * @param {string} campo
 * @param {{min?: number, max?: number}} [opts]
 * @returns {string}
 */
export function texto(v, campo, { min = 1, max = 500 } = {}) {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min) throw ApiError.badRequest(`${campo} é obrigatório.`);
  if (s.length > max) throw ApiError.badRequest(`${campo} deve ter no máximo ${max} caracteres.`);
  return s;
}

/**
 * @param {unknown} v
 * @param {string} campo
 * @param {{max?: number, padrao?: string|null}} [opts]
 * @returns {string|null}
 */
export function textoOpcional(v, campo, { max = 500, padrao = null } = {}) {
  if (vazio(v)) return padrao;
  return texto(v, campo, { min: 1, max });
}

/**
 * @param {unknown} v
 * @param {string} campo
 * @returns {string} e-mail em minúsculas
 */
export function email(v, campo = "E-mail") {
  const s = texto(v, campo, { max: 254 }).toLowerCase();
  if (!RE_EMAIL.test(s)) throw ApiError.badRequest(`${campo} inválido.`);
  return s;
}

/** @returns {string|null} */
export function emailOpcional(v, campo = "E-mail") {
  return vazio(v) ? null : email(v, campo);
}

/**
 * @param {unknown} v
 * @param {string} campo
 * @returns {string}
 */
export function uuid(v, campo) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!RE_UUID.test(s)) throw ApiError.badRequest(`${campo} inválido.`);
  return s;
}

/** @returns {string|null} */
export function uuidOpcional(v, campo) {
  return vazio(v) ? null : uuid(v, campo);
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {string} campo
 * @param {readonly T[]} valores
 * @returns {T}
 */
export function umDe(v, campo, valores) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!valores.includes(/** @type {T} */ (s))) {
    throw ApiError.badRequest(`${campo} inválido. Aceito: ${valores.join(", ")}.`);
  }
  return /** @type {T} */ (s);
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {string} campo
 * @param {readonly T[]} valores
 * @param {T|null} [padrao]
 * @returns {T|null}
 */
export function umDeOpcional(v, campo, valores, padrao = null) {
  return vazio(v) ? padrao : umDe(v, campo, valores);
}

/**
 * @param {unknown} v
 * @param {string} campo
 * @param {{min?: number, max?: number}} [opts]
 * @returns {number}
 */
export function numero(v, campo, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (vazio(v) || Number.isNaN(n)) throw ApiError.badRequest(`${campo} deve ser um número.`);
  if (n < min || n > max) throw ApiError.badRequest(`${campo} deve estar entre ${min} e ${max}.`);
  return n;
}

/** @returns {number} */
export function numeroOpcional(v, campo, { min, max, padrao = 0 } = {}) {
  return vazio(v) ? padrao : numero(v, campo, { min, max });
}

/**
 * Inteiro com recorte em faixa (não lança: satura). Ideal para `?limite=`,
 * onde um valor absurdo do cliente deve virar o teto, não um erro.
 * @param {unknown} v
 * @param {number} padrao
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function limite(v, padrao = 50, min = 1, max = 500) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {unknown} v
 * @param {boolean} [padrao]
 * @returns {boolean}
 */
export function booleano(v, padrao = false) {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return padrao;
}

/**
 * Senha: o mínimo do Supabase Auth é 6, mas o sistema exige 8 desde sempre —
 * mantém a regra que os usuários já conhecem.
 * @param {unknown} v
 * @returns {string}
 */
export function senha(v) {
  const s = typeof v === "string" ? v : "";
  if (s.length < 8) throw ApiError.badRequest("A senha deve ter ao menos 8 caracteres.");
  if (s.length > 72) throw ApiError.badRequest("A senha deve ter no máximo 72 caracteres.");
  return s;
}

/**
 * Data no formato ISO `YYYY-MM-DD`.
 * @param {unknown} v
 * @param {string} campo
 * @returns {string|null}
 */
export function dataOpcional(v, campo) {
  if (vazio(v)) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw ApiError.badRequest(`${campo} deve estar no formato AAAA-MM-DD.`);
  }
  return s;
}

/**
 * CNPJ: guarda só os 14 dígitos. Não valida dígito verificador de propósito —
 * o cadastro de uma empresa não pode travar por causa de um CNPJ atípico, e a
 * conferência fiscal não é papel desta camada.
 * @param {unknown} v
 * @returns {string|null}
 */
export function cnpjOpcional(v) {
  if (vazio(v)) return null;
  const d = String(v).replace(/\D/g, "");
  if (!d) return null;
  if (d.length !== 14) throw ApiError.badRequest("CNPJ deve ter 14 dígitos.");
  return d;
}

/**
 * Telefone: mantém apenas dígitos (10 a 13, cobrindo DDI + DDD + número).
 * @param {unknown} v
 * @returns {string|null}
 */
export function telefoneOpcional(v) {
  if (vazio(v)) return null;
  const d = String(v).replace(/\D/g, "");
  if (!d) return null;
  if (d.length < 10 || d.length > 13) throw ApiError.badRequest("Telefone inválido.");
  return d;
}

/**
 * URL http(s). Recusa outros esquemas — `javascript:` numa logo renderizada
 * no painel seria XSS.
 * @param {unknown} v
 * @param {string} campo
 * @returns {string|null}
 */
export function urlOpcional(v, campo) {
  if (vazio(v)) return null;
  const s = String(v).trim();
  let u;
  try { u = new URL(s); } catch { throw ApiError.badRequest(`${campo} deve ser uma URL válida.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw ApiError.badRequest(`${campo} deve começar com http:// ou https://.`);
  }
  return s;
}

/**
 * Garante que o corpo da requisição é um objeto (e não array/null/string).
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
export function corpo(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.badRequest("Corpo da requisição inválido.");
  }
  return /** @type {Record<string, unknown>} */ (body);
}
