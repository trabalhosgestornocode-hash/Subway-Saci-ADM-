export class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
  static badRequest(msg, details) { return new ApiError(400, msg, details); }
  static unauthorized(msg = "Não autenticado") { return new ApiError(401, msg); }
  static forbidden(msg = "Acesso negado") { return new ApiError(403, msg); }
  static notFound(msg = "Não encontrado") { return new ApiError(404, msg); }
  static internal(msg = "Erro interno") { return new ApiError(500, msg); }
}
