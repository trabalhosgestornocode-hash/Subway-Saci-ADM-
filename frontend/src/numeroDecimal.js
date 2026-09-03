const FORMATADOR_BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function limparTextoMoeda(valor) {
  return String(valor)
    .trim()
    .replace(/^R\$\s*/i, "")
    .replace(/[\s\u00a0\u202f]/g, "");
}

/** Converte dinheiro pt-BR para o numero enviado pela API. */
export function numeroDecimal(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : Number.NaN;
  if (valor == null) return Number.NaN;
  const texto = limparTextoMoeda(valor);
  if (!texto) return Number.NaN;

  // Ponto e sempre milhar; centavos so existem quando ha virgula.
  const formatoBrasileiro = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/;
  if (!formatoBrasileiro.test(texto)) return Number.NaN;
  const numero = Number(texto.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(numero) ? numero : Number.NaN;
}

export function numeroDecimalOuIndefinido(valor) {
  return valor === "" || valor == null ? undefined : numeroDecimal(valor);
}

/** Formato final, usado no carregamento e no blur. Vazio continua vazio. */
export function formatarMoedaBRL(valor) {
  if (valor === "" || valor == null) return "";
  const numero = numeroDecimal(valor);
  return Number.isFinite(numero) ? FORMATADOR_BRL.format(numero) : String(valor);
}

/** Mascara editavel que preserva virgula e centavos parciais. */
export function formatarMoedaDuranteDigitacao(valor, { permiteNegativo = false } = {}) {
  if (valor == null) return "";
  let texto = limparTextoMoeda(valor);
  if (!texto) return "";

  const negativo = permiteNegativo && texto.startsWith("-");
  texto = texto.replace(/^[+-]/, "").replace(/[^\d.,]/g, "");
  const partes = texto.split(",");
  const temVirgula = partes.length > 1;
  const inteiroDigitos = (partes.shift() ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "") || "0";
  const centavos = partes.join("").replace(/\D/g, "").slice(0, 2);
  const inteiro = inteiroDigitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${negativo ? "-" : ""}${inteiro}${temVirgula ? `,${centavos}` : ""}`;
}

function posicaoPorCaracteresSignificativos(texto, quantidade) {
  if (quantidade <= 0) return texto.startsWith("R$ ") ? 3 : 0;
  let vistos = 0;
  for (let i = 0; i < texto.length; i += 1) {
    if (/[\d,-]/.test(texto[i])) vistos += 1;
    if (vistos >= quantidade) return i + 1;
  }
  return texto.length;
}

/** Liga mascara, paste e blur a um input sem mudar o contrato numerico. */
export function aplicarMascaraMoeda(input, { permiteNegativo = false, aoAlterar } = {}) {
  if (!input) return;
  input.value = formatarMoedaBRL(input.value);
  input.addEventListener("input", () => {
    const antesDoCursor = input.value.slice(0, input.selectionStart ?? input.value.length);
    const significativos = (antesDoCursor.match(/[\d,-]/g) ?? []).length;
    input.value = formatarMoedaDuranteDigitacao(input.value, { permiteNegativo });
    const posicao = posicaoPorCaracteresSignificativos(input.value, significativos);
    input.setSelectionRange?.(posicao, posicao);
    aoAlterar?.(input.value);
  });
  input.addEventListener("blur", () => {
    if (input.value !== "") input.value = formatarMoedaBRL(input.value);
    aoAlterar?.(input.value);
  });
}
