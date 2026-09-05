// Classificação de eventos de segurança para auditoria (P0.10).
//
// O que protege: um incidente (brute force de PIN, spray de rate limit,
// tentativa de acessar /plataforma sem ser SuperAdmin, MFA barrado) tem de
// deixar rastro na auditoria — SEM gravar senha/PIN/token/payload. E o
// contrário: 4xx normais (validação, 404, permissão de módulo comum) NÃO
// viram ruído.

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);

import { test } from "node:test";
import assert from "node:assert/strict";

const { classificarEventoSeguranca } = await import("../src/middlewares/errorHandler.js");
const { ACOES } = await import("../src/shared/auditoria.js");

const req = (over = {}) => ({ method: "POST", path: "/api/v1/sessao/selecionar-perfil", ...over });

test("429 de rate limit -> seguranca.rate_limit_excedido", () => {
  const ev = classificarEventoSeguranca(req(), { statusCode: 429, details: { codigo: "RATE_LIMITED" } });
  assert.equal(ev.acao, ACOES.SEGURANCA_RATE_LIMIT);
  assert.match(ev.detalhes.rota, /selecionar-perfil/);
});

test("MFA barrado -> seguranca.mfa_requerida, com o AAL atual", () => {
  const ev = classificarEventoSeguranca(
    req({ path: "/api/v1/plataforma/usuarios", user: { aal: "aal1" } }),
    { statusCode: 401, details: { codigo: "MFA_REQUERIDA" } },
  );
  assert.equal(ev.acao, ACOES.SEGURANCA_MFA_REQUERIDA);
  assert.equal(ev.detalhes.aal, "aal1");
});

test("PIN bloqueado -> perfil.pin_bloqueado", () => {
  const ev = classificarEventoSeguranca(req(), { statusCode: 429, details: { codigo: "PIN_TEMPORARIAMENTE_BLOQUEADO" } });
  assert.equal(ev.acao, ACOES.PERFIL_PIN_BLOQUEADO);
});

test("403 em /plataforma ou /administrativo -> seguranca.acesso_negado", () => {
  for (const p of ["/api/v1/plataforma/empresas", "/api/v1/administrativo/visao-geral"]) {
    const ev = classificarEventoSeguranca(req({ method: "GET", path: p }), { statusCode: 403, message: "Ação restrita ao SuperAdmin da plataforma." });
    assert.equal(ev.acao, ACOES.SEGURANCA_ACESSO_NEGADO);
    assert.ok(ev.detalhes.motivo.length > 0);
  }
});

test("NÃO gera evento: 404, 400 de validação, 403 de módulo comum, 401 normal", () => {
  assert.equal(classificarEventoSeguranca(req({ path: "/api/v1/dashboard" }), { statusCode: 404 }), null);
  assert.equal(classificarEventoSeguranca(req(), { statusCode: 400, message: "Campo obrigatório." }), null);
  assert.equal(classificarEventoSeguranca(req({ path: "/api/v1/produtos" }), { statusCode: 403, message: "Módulo não contratado." }), null);
  assert.equal(classificarEventoSeguranca(req(), { statusCode: 401, message: "Sessão inválida ou expirada." }), null);
});

test("os detalhes NUNCA carregam PIN/senha/token — só rota e motivo curto", () => {
  const ev = classificarEventoSeguranca(
    req(),
    { statusCode: 429, details: { codigo: "PIN_TEMPORARIAMENTE_BLOQUEADO" }, message: "PIN 1234 incorreto para o token abc.def.ghi" },
  );
  const blob = JSON.stringify(ev.detalhes);
  assert.doesNotMatch(blob, /1234|abc\.def|senha|password|bearer/i);
});
