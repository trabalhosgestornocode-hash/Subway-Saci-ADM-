// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.statusCode || 500;
  if (status >= 500) console.error("[erro]", err);
  res.status(status).json({ error: err.message || "Erro interno", details: err.details });
}
