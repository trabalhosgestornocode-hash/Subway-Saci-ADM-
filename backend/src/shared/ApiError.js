export class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
  static badRequest(msg, details) { return new ApiError(400, msg, details); }
  static unauthorized(msg = "Não autenticado", details) { return new ApiError(401, msg, details); }
  static forbidden(msg = "Acesso negado", details) { return new ApiError(403, msg, details); }
  static notFound(msg = "Não encontrado", details) { return new ApiError(404, msg, details); }
  static tooManyRequests(msg = "Muitas tentativas", details) { return new ApiError(429, msg, details); }
  static internal(msg = "Erro interno") { return new ApiError(500, msg); }
}
