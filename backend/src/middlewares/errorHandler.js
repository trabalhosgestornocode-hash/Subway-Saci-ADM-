import { emProducao } from "../config/seguranca.js";
import { auditar, ACOES, contextoDaRequisicao } from "../shared/auditoria.js";

// Em PRODUÇÃO, erro 5xx nunca vaza detalhe interno para o cliente: mensagem de
// banco, caminho de arquivo e stack ficam só no log do servidor. Erros 4xx são
// intencionais (validação, permissão) e continuam explicando o que houve.
//
// `details` só é devolvido em 4xx — é onde ele carrega informação útil ao
// usuário. Em 5xx poderia carregar eco de payload, então é omitido.

/** Rotas onde um 403 é sinal de tentativa de acesso a superfície privilegiada. */
const RE_SUPERFICIE_PRIVILEGIADA = /^\/api\/v1\/(plataforma|administrativo)\b/;

/**
 * DECISÃO PURA: um erro merece uma linha de auditoria de segurança? Qual?
 * Só dispara para os casos que importam para detecção; o resto dos 4xx é ruído.
 * @param {{method?: string, path?: string, user?: {aal?: string}}} req
 * @param {any} err
 * @returns {{ acao: string, detalhes: Record<string, unknown> } | null}
 */
export function classificarEventoSeguranca(req, err) {
  const codigo = err?.codigo ?? err?.details?.codigo ?? null;
  const detalhes = { rota: `${req?.method ?? "?"} ${req?.path ?? "?"}` };

  if (codigo === "RATE_LIMITED") return { acao: ACOES.SEGURANCA_RATE_LIMIT, detalhes };
  if (codigo === "MFA_REQUERIDA") return { acao: ACOES.SEGURANCA_MFA_REQUERIDA, detalhes: { ...detalhes, aal: req?.user?.aal ?? null } };
  if (codigo === "PIN_TEMPORARIAMENTE_BLOQUEADO") return { acao: ACOES.PERFIL_PIN_BLOQUEADO, detalhes };
  if (err?.statusCode === 403 && RE_SUPERFICIE_PRIVILEGIADA.test(req?.path ?? "")) {
    return { acao: ACOES.SEGURANCA_ACESSO_NEGADO, detalhes: { ...detalhes, motivo: String(err.message || "").slice(0, 120) } };
  }
  return null;
}

/**
 * Registra o evento (se houver) — fire-and-forget, JAMAIS bloqueia a resposta
 * (auditar() já engole o próprio erro).
 */
function registrarEventoSeguranca(req, err) {
  try {
    const ev = classificarEventoSeguranca(req, err);
    if (!ev) return;
    auditar({ ...contextoDaRequisicao(req), acao: ev.acao, entidade: "seguranca", detalhes: ev.detalhes });
  } catch { /* nunca propaga */ }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;

  // Corpo maior que o limite da rota (express.json's PayloadTooLargeError) —
  // a mensagem padrão ("request entity too large") vaza em inglês e não diz
  // o que fazer. Isto é sempre limite de UPLOAD (arquivo grande), nunca um
  // erro de negócio, então vale um 413 traduzido em vez de cair no genérico.
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Arquivo(s) grande(s) demais para esta operação. Reduza o tamanho e tente novamente." });
  }

  // Evento de segurança (assíncrono, não bloqueia a resposta).
  registrarEventoSeguranca(req, err);

  if (status >= 500) {
    console.error("[erro]", { rota: `${req.method} ${req.path}`, mensagem: err.message, stack: err.stack });
    return res.status(status).json({
      error: emProducao ? "Erro interno. Tente novamente em instantes." : (err.message || "Erro interno"),
      ...(err.codigo ? { codigo: err.codigo } : {}),
    });
  }

  res.status(status).json({
    error: err.message || "Requisição inválida",
    details: err.details,
    ...(err.codigo ? { codigo: err.codigo } : {}),
  });
}
