// Validação de payload das rotas Martin Brower.
//
// PRINCÍPIO: organizacaoId e unidadeId NUNCA são lidos do corpo da requisição.
// Eles vêm de req.tenant, já resolvido e validado pelo requireAuth contra os
// vínculos do usuário. O que chega do cliente é só: qual unidade selecionar
// (validada contra os vínculos), clientId na configuração, código 2FA e
// filtros de listagem.

import { ApiError } from "../../shared/ApiError.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validarUuid(valor, campo) {
  if (!valor || !UUID_RE.test(String(valor))) throw ApiError.badRequest(`${campo} inválido.`);
  return String(valor);
}

// clientId do portal — tratado como IDENTIFICADOR, nunca como número.
//
// Devolve STRING (migration 019). Converter para Number destruía zeros à
// esquerda: "04532" virava 4532, e o código deixava de casar com o que o
// portal e a configuração da loja usam. É o mesmo raciocínio que já valia para
// o `codigo` do produto.
//
// Ainda assim exige APENAS DÍGITOS: o valor vai direto para a query string de
// uma chamada externa, e aceitar texto livre abriria espaço para injeção de
// parâmetro. Zeros à esquerda são preservados; espaços nas bordas são apenas
// aparados (o usuário colando do portal costuma trazê-los), o que não altera
// o identificador.
export function validarClientId(valor) {
  const s = String(valor ?? "").trim();
  if (!/^\d{1,32}$/.test(s)) {
    throw ApiError.badRequest("Código de cliente Martin Brower inválido: informe apenas números.");
  }
  // "0" ou "000" não identificam loja nenhuma.
  if (/^0+$/.test(s)) {
    throw ApiError.badRequest("Código de cliente Martin Brower inválido: informe apenas números.");
  }
  return s;
}

// Compara dois clientId como IDENTIFICADORES. "04532" e "4532" são
// DIFERENTES — é justamente o ponto da migration 019. Existe para que nenhuma
// comparação acidental use == entre string e number.
export function mesmoClientId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// Credenciais: validadas em FORMA apenas. Nunca ecoadas, nunca logadas,
// nunca incluídas em mensagem de erro.
export function validarCredenciais(body) {
  const usuario = typeof body?.usuario === "string" ? body.usuario.trim() : "";
  const senha = typeof body?.senha === "string" ? body.senha : "";
  if (!usuario || usuario.length > 200) throw ApiError.badRequest("Informe o usuário do portal Martin Brower.");
  if (!senha || senha.length > 200) throw ApiError.badRequest("Informe a senha do portal Martin Brower.");
  return { usuario, senha };
}

export function validarCodigo2fa(body) {
  const codigo = String(body?.codigo ?? "").trim();
  if (!/^[A-Za-z0-9]{4,12}$/.test(codigo)) throw mbErro(MB_ERROS.MARTIN_BROWER_2FA_INVALID);
  return codigo;
}

export function validarSessionId(valor) {
  const s = String(valor ?? "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(s)) throw ApiError.badRequest("Sessão inválida.");
  return s;
}

// Payload do loadItens na importação manual administrativa (ferramenta
// temporária de teste). Valida a FORMA antes de deixar entrar no normalizador.
export function validarPayloadCatalogo(body) {
  const payload = body?.payload ?? body;
  if (!payload || typeof payload !== "object") {
    throw ApiError.badRequest("Envie o JSON da resposta de loadItens no campo 'payload'.");
  }
  if (!Array.isArray(payload?.data?.groups)) {
    throw mbErro(MB_ERROS.MARTIN_BROWER_CATALOG_INVALID, {
      detalhes: { motivo: "esperado data.groups[] na raiz do JSON" },
    });
  }
  return payload;
}

// orderId da importação manual: opcional, mas se vier tem que ser inteiro.
export function validarOrderIdOpcional(valor) {
  if (valor == null || valor === "") return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw ApiError.badRequest("orderId inválido.");
  return n;
}

// O termo de busca entra num filtro PostgREST montado como string, onde
// vírgula, ponto e parênteses são SINTAXE — não valor. Removemos tudo que não
// seja letra, número, espaço, hífen, sublinhado ou barra, para que o termo
// digitado não consiga acrescentar condições à consulta.
//
// Efeito colateral aceito: buscar "2,5 KG" vira "2 5 KG" e não casa por ILIKE.
// Perder essa busca vale menos que deixar a sintaxe do filtro aberta.
export function sanitizarTermoBusca(termo) {
  if (typeof termo !== "string") return null;
  const limpo = termo.replace(/[^\p{L}\p{N}\s\-_/]/gu, " ").replace(/\s+/g, " ").trim();
  return limpo.slice(0, 80) || null;
}

export function validarFiltrosListagem(query = {}) {
  const texto = (v, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  return {
    busca: texto(query.busca),
    grupo: texto(query.grupo),
    familia: texto(query.familia, 20),
    ignorado: ["true", "false"].includes(query.ignorado) ? query.ignorado : undefined,
    ativo: ["true", "false"].includes(query.ativo) ? query.ativo : undefined,
    ordem: ["descricao", "codigo", "preco", "atualizacao"].includes(query.ordem) ? query.ordem : "descricao",
    direcao: query.direcao === "desc" ? "desc" : "asc",
    limite: Math.min(Number(query.limite) || 500, 2000),
  };
}
