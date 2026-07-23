import { emProducao } from "../config/seguranca.js";

// Em PRODUÇÃO, erro 5xx nunca vaza detalhe interno para o cliente: mensagem de
// banco, caminho de arquivo e stack ficam só no log do servidor. Erros 4xx são
// intencionais (validação, permissão) e continuam explicando o que houve.
//
// `details` só é devolvido em 4xx — é onde ele carrega informação útil ao
// usuário. Em 5xx poderia carregar eco de payload, então é omitido.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;

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
