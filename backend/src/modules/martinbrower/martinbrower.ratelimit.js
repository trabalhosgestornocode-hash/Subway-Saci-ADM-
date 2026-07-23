// Rate limiting em memória para as rotas sensíveis da integração.
//
// Implementado à mão em vez de trazer express-rate-limit: são ~30 linhas, e a
// Fase 1/2 tem como meta explícita NÃO aumentar o consumo de memória do
// backend em produção nem adicionar dependência.
//
// Janela deslizante simples por usuário. Como as sessões já vivem em memória
// do processo, um contador em memória tem exatamente a mesma validade.

import { MB_RATE_LIMIT } from "./martinbrower.constants.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";

const acessos = new Map(); // chave -> number[] (timestamps)

export function limitarPorUsuario({ max = MB_RATE_LIMIT.maxPorUsuario, janelaMs = MB_RATE_LIMIT.janelaMs, escopo = "geral" } = {}) {
  return (req, _res, next) => {
    // Chaveia por usuário autenticado, não por IP: o requireAuth já rodou, e
    // IP atrás do proxy do Render é compartilhado.
    const chave = `${escopo}:${req.user?.id ?? "anon"}`;
    const agora = Date.now();
    const janela = (acessos.get(chave) ?? []).filter((t) => agora - t < janelaMs);

    if (janela.length >= max) return next(mbErro(MB_ERROS.MARTIN_BROWER_RATE_LIMITED));

    janela.push(agora);
    acessos.set(chave, janela);
    next();
  };
}

// Limpeza periódica para o Map não crescer indefinidamente.
const limpeza = setInterval(() => {
  const agora = Date.now();
  for (const [k, ts] of acessos) {
    const vivos = ts.filter((t) => agora - t < MB_RATE_LIMIT.janelaMs);
    if (vivos.length) acessos.set(k, vivos); else acessos.delete(k);
  }
}, 5 * 60_000);
limpeza.unref?.();
