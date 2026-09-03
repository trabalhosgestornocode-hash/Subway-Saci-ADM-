// Rate limiting reutilizável — camada ÚNICA para toda a API.
//
// Janela deslizante em memória do processo. Mesmo desenho que
// ifood.ratelimit.js e martinbrower.ratelimit.js já usavam (sem dependência
// nova, ~contadores em memória com a mesma validade das sessões em memória),
// só que genérico e com chave configurável.
//
// CHAVE (regra de ouro atrás de proxy):
//   - por CONTA:  req.user.id           -> o padrão. requireAuth já rodou.
//   - por IP:     req.ip                 -> respeita `trust proxy` de app.js;
//                                          NUNCA lê x-forwarded-for cru.
//   - composta:   qualquer função sua    -> ex.: `${conta}|${escopo}`.
//
// RESPOSTA: 429 genérico (`ApiError.tooManyRequests`) + header Retry-After.
// A mensagem é a MESMA independentemente de a conta/perfil existir — não vaza
// nada sobre o alvo.

import { ApiError } from "./ApiError.js";

/** Um Map global por escopo, para o cleanup varrer todos de uma vez. */
const registros = new Map(); // escopo -> Map(chave -> number[] timestamps)

function baldeDoEscopo(escopo) {
  let b = registros.get(escopo);
  if (!b) { b = new Map(); registros.set(escopo, b); }
  return b;
}

/**
 * IP do cliente para fins de rate limiting. Usa `req.ip`, que já respeita o
 * `app.set("trust proxy", 1)` de app.js — em produção resolve o IP real antes
 * do proxy do Render; em dev/teste é o IP do socket. Nunca confia no header
 * cru. `null` quando indisponível (a chave cai só na conta).
 * @param {import('express').Request} req
 */
export function ipCliente(req) {
  const ip = req.ip || req.socket?.remoteAddress || null;
  return ip ? String(ip) : null;
}

/**
 * Cria um middleware de rate limit.
 *
 * @param {object} opts
 * @param {string} opts.escopo          namespace do contador (ex.: "sessao:pin")
 * @param {number} opts.max             máximo de requisições na janela
 * @param {number} opts.janelaMs        tamanho da janela deslizante
 * @param {(req: import('express').Request) => (string|null)} [opts.chave]
 *        função que deriva a chave. Default: a conta (`req.user.id`).
 *        Retornar `null` = "não sei quem é" -> a requisição PASSA (o limite
 *        não pode ser a única barreira; requireAuth já barrou quem não tem conta).
 * @returns {import('express').RequestHandler}
 */
export function limiteDeTaxa({ escopo, max, janelaMs, chave }) {
  if (!escopo || !(max > 0) || !(janelaMs > 0)) {
    throw new Error("limiteDeTaxa: escopo, max e janelaMs são obrigatórios.");
  }
  const derivarChave = chave ?? ((req) => req.user?.id ?? null);
  const balde = baldeDoEscopo(escopo);

  return (req, res, next) => {
    const k = derivarChave(req);
    if (k == null || k === "") return next(); // sem chave confiável -> não bloqueia

    const agora = Date.now();
    const janela = (balde.get(k) ?? []).filter((t) => agora - t < janelaMs);
    const bloqueado = janela.length >= max;

    // Headers padrão (draft-ietf-httpapi-ratelimit-headers). Só refletem o
    // balde DESTE chamador (chave = conta/IP dele) — não vazam nada de outro
    // tenant. Com `combinar()`, o limite MAIS APERTADO prevalece (só sobrescreve
    // se o "restante" for menor que o já publicado).
    const restante = Math.max(0, max - janela.length - (bloqueado ? 0 : 1));
    const resetSeg = janela.length
      ? Math.max(1, Math.ceil((janelaMs - (agora - janela[0])) / 1000))
      : Math.ceil(janelaMs / 1000);
    const restanteAtual = Number(res.getHeader?.("RateLimit-Remaining"));
    if (!Number.isFinite(restanteAtual) || restante <= restanteAtual) {
      res.setHeader("RateLimit-Limit", max);
      res.setHeader("RateLimit-Remaining", restante);
      res.setHeader("RateLimit-Reset", resetSeg);
    }

    if (bloqueado) {
      res.setHeader("Retry-After", resetSeg);
      return next(new ApiError(429, "Muitas requisições em pouco tempo. Aguarde alguns instantes e tente de novo.", { codigo: "RATE_LIMITED" }));
    }

    janela.push(agora);
    balde.set(k, janela);
    next();
  };
}

/**
 * Combinador: aplica vários limites na ordem dada (o primeiro que estourar
 * responde). Útil para "por conta E por IP" no mesmo endpoint.
 * @param {...import('express').RequestHandler} limites
 */
export function combinar(...limites) {
  return (req, res, next) => {
    let i = 0;
    const passo = (err) => (err ? next(err) : i < limites.length ? limites[i++](req, res, passo) : next());
    passo();
  };
}

/** Limpeza periódica — remove chaves sem timestamps vivos. Não trava o processo. */
const JANELA_MAX_CONHECIDA = 24 * 60 * 60_000;
const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [escopo, balde] of registros) {
    for (const [k, ts] of balde) {
      const vivos = ts.filter((t) => agora - t < JANELA_MAX_CONHECIDA);
      if (vivos.length) balde.set(k, vivos); else balde.delete(k);
    }
    if (!balde.size) registros.delete(escopo);
  }
}, 10 * 60_000);
limpeza.unref?.();

/** Só para teste: zera todos os contadores. */
export function _resetarLimites() {
  registros.clear();
}
