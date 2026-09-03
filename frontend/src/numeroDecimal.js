/**
 * Converte um valor monetario digitado no formato brasileiro ou no formato
 * canonico usado pela API. A API continua recebendo JSON numerico.
 *
 * Exemplos: "123,45" -> 123.45; "123.45" -> 123.45;
 * "1.234,56" -> 1234.56. Entradas invalidas retornam NaN.
 */
export function numeroDecimal(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : Number.NaN;
  if (valor == null) return Number.NaN;

  const texto = String(valor).trim();
  if (!texto) return Number.NaN;

  // Formatos aceitos sao deliberadamente estritos para nunca reinterpretar
  // silenciosamente um valor financeiro mal agrupado. O brasileiro aceita
  // milhar com ponto e ate dois centavos; o canonico aceita ponto decimal.
  const formatoBrasileiro = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/;
  const formatoCanonico = /^[+-]?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;
  let normalizado;
  if (formatoBrasileiro.test(texto)) normalizado = texto.replace(/\./g, "").replace(",", ".");
  else if (formatoCanonico.test(texto)) normalizado = texto;
  else return Number.NaN;

  const numero = Number(normalizado);
  return Number.isFinite(numero) ? numero : Number.NaN;
}

export function numeroDecimalOuIndefinido(valor) {
  return valor === "" || valor == null ? undefined : numeroDecimal(valor);
}
