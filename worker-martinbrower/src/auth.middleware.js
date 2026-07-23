// Autenticação servidor-servidor por HMAC.
//
// SEGUNDA CAMADA. A primeira é o IAM do Cloud Run: o serviço sobe com
// --no-allow-unauthenticated e o Google recusa quem não apresentar um ID token
// OIDC válido, ANTES de a requisição chegar aqui. O HMAC existe para o caso de
// alguém conseguir invocar o serviço mesmo assim.
//
// O QUE É ASSINADO
//   timestamp \n nonce \n MÉTODO \n path+querystring \n sha256(corpo)
//
// Assinar o corpo é o que impede troca de credenciais em trânsito; assinar o
// path+query é o que impede redirecionar a chamada para outra sessão.
//
// PROTEÇÕES
//   * janela de 60 s (timestamp fora disso = rejeitado)
//   * nonce de uso único dentro da janela (replay = rejeitado)
//   * comparação em tempo constante (timingSafeEqual)
//   * cache de nonces com teto e limpeza — não cresce indefinidamente
//   * segredo e assinatura completa NUNCA são logados

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { log, prefixoAssinatura } from "./logsafe.js";

export const JANELA_MS = 60_000;          // ±60 s, conforme especificado
const NONCE_TETO = 10_000;                // teto duro do cache
const LIMPEZA_MS = 30_000;

// nonce -> instante em que expira
const noncesVistos = new Map();

const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [nonce, expira] of noncesVistos) {
    if (expira <= agora) noncesVistos.delete(nonce);
  }
}, LIMPEZA_MS);
limpeza.unref?.();

export function _resetarNonces() { noncesVistos.clear(); }

/** Monta a mensagem canônica. Backend e worker precisam gerar IDÊNTICA. */
export function montarMensagem({ timestamp, nonce, metodo, caminho, corpo }) {
  const hashCorpo = createHash("sha256").update(corpo ?? "").digest("hex");
  return [timestamp, nonce, String(metodo).toUpperCase(), caminho, hashCorpo].join("\n");
}

export function assinar({ segredo, timestamp, nonce, metodo, caminho, corpo }) {
  return createHmac("sha256", segredo)
    .update(montarMensagem({ timestamp, nonce, metodo, caminho, corpo }))
    .digest("hex");
}

// Comparação em tempo constante. Strings de tamanhos diferentes não podem ir
// para timingSafeEqual (ele lança), então o tamanho é checado antes — o que
// não vaza informação útil, já que o tamanho da assinatura é fixo e público.
function iguaisEmTempoConstante(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Middleware Express. Exige `express.raw()` antes dele, para que o corpo
 * assinado seja exatamente o que trafegou — reserializar JSON mudaria os bytes
 * e quebraria a assinatura.
 */
export function exigirHmac(segredo) {
  if (!segredo) throw new Error("MB_WORKER_SECRET ausente — o worker recusa subir sem segredo.");

  return (req, res, next) => {
    const timestamp = req.get("X-MB-Timestamp");
    const nonce = req.get("X-MB-Nonce");
    const assinatura = req.get("X-MB-Signature");

    const recusar = (motivo, detalhe = {}) => {
      // Loga o motivo e o prefixo da assinatura — nunca o segredo nem a
      // assinatura inteira, que serviria para montar um ataque offline.
      log("warn", "hmac.recusado", { motivo, ...detalhe, assinatura: prefixoAssinatura(assinatura) });
      // Resposta genérica: não confirmamos QUAL parte falhou.
      return res.status(401).json({ error: "unauthorized" });
    };

    if (!timestamp || !nonce || !assinatura) return recusar("cabecalho ausente");
    if (!/^\d{10,13}$/.test(timestamp)) return recusar("timestamp malformado");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return recusar("nonce malformado");

    const agora = Date.now();
    const ts = Number(timestamp);
    // Aceita ±JANELA: o relógio do Render pode estar levemente à frente.
    if (Math.abs(agora - ts) > JANELA_MS) {
      return recusar("timestamp fora da janela", { desvioMs: agora - ts });
    }

    if (noncesVistos.has(nonce)) return recusar("replay (nonce reutilizado)");
    // Teto duro: sob enxurrada, preferimos recusar a estourar a memória do
    // container — que mataria a sessão de sincronização em andamento.
    if (noncesVistos.size >= NONCE_TETO) {
      log("error", "hmac.cache_cheio", { tamanho: noncesVistos.size });
      return res.status(503).json({ error: "worker_busy" });
    }

    // req.body é Buffer (express.raw). Compara os bytes exatos recebidos.
    const corpo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const caminho = req.originalUrl;   // inclui a query string, como especificado

    const esperada = assinar({ segredo, timestamp, nonce, metodo: req.method, caminho, corpo });
    if (!iguaisEmTempoConstante(assinatura, esperada)) {
      return recusar("assinatura invalida", { caminho });
    }

    // Só registra o nonce DEPOIS de a assinatura conferir: senão um atacante
    // poderia queimar nonces legítimos enviando lixo assinado errado.
    noncesVistos.set(nonce, agora + JANELA_MS);

    // Disponibiliza o corpo já parseado; nenhuma rota reparseia.
    try {
      req.corpoJson = corpo ? JSON.parse(corpo) : {};
    } catch {
      return res.status(400).json({ error: "corpo_invalido" });
    }
    next();
  };
}
