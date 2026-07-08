// Envolve handlers async para encaminhar erros ao errorHandler sem try/catch repetido.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
