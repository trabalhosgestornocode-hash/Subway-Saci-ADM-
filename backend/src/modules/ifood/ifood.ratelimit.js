// Rate limiting em memória para as rotas sensíveis da integração iFood.
//
// Mesmo desenho de martinbrower.ratelimit.js: ~30 linhas, sem dependência
// nova, janela deslizante por usuário autenticado (não por IP — o proxy do
// Render compartilha IP).

import { IFOOD_RATE_LIMIT } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";

const acessos = new Map(); // chave -> number[] (timestamps)

export function limitarPorUsuario({ max = 10, janelaMs = IFOOD_RATE_LIMIT.janelaMs, escopo = "geral" } = {}) {
  return (req, _res, next) => {
    const chave = `${escopo}:${req.user?.id ?? "anon"}`;
    const agora = Date.now();
    const janela = (acessos.get(chave) ?? []).filter((t) => agora - t < janelaMs);

    if (janela.length >= max) return next(ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED));

    janela.push(agora);
    acessos.set(chave, janela);
    next();
  };
}

// Limpeza periódica para o Map não crescer indefinidamente.
const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [k, ts] of acessos) {
    const vivos = ts.filter((t) => agora - t < IFOOD_RATE_LIMIT.janelaMs);
    if (vivos.length) acessos.set(k, vivos); else acessos.delete(k);
  }
}, 5 * 60_000);
limpeza.unref?.();
