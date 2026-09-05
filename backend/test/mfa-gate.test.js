// Gates de MFA (verificação em duas etapas) para acessos críticos — P0.6.
//
// O que protegem: quando a política está LIGADA, uma sessão sem AAL2 (só
// senha) não entra no painel crítico; quando está DESLIGADA (default), nada
// muda. E `req.user.aal` nunca é a única barreira — requireSuperadmin/
// requirePainelAdministrativo continuam antes.
//
// Este arquivo LIGA MFA_ENFORCE_SUPERADMIN e deixa MFA_ENFORCE_PAINEL_ADM
// desligado — cobre os dois caminhos. Env fake do Supabase p/ config/env.js
// não abortar (nenhum teste aqui faz rede).

// env ANTES de qualquer import da app (config/env.js aborta o processo se
// faltar SUPABASE_*). Import dinâmico para o env valer.
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
process.env.MFA_ENFORCE_SUPERADMIN = "true";
delete process.env.MFA_ENFORCE_PAINEL_ADM;

import { test } from "node:test";
import assert from "node:assert/strict";

const { requireAAL2, exigirMfaSeExigido } = await import("../src/middlewares/auth.js");

function passar(mw, user) {
  let erro = "NAO_CHAMOU";
  mw({ user }, {}, (e) => { erro = e ?? null; });
  return erro;
}

test("requireAAL2: aal2 passa, aal1/ausente -> 401 MFA_REQUERIDA", () => {
  assert.equal(passar(requireAAL2, { aal: "aal2" }), null);
  for (const u of [{ aal: "aal1" }, { aal: null }, {}]) {
    const e = passar(requireAAL2, u);
    assert.equal(e.statusCode, 401);
    assert.equal(e.details?.codigo, "MFA_REQUERIDA");
  }
});

test("exigirMfaSeExigido('superadmin') LIGADO: exige aal2", () => {
  const mw = exigirMfaSeExigido("superadmin");
  assert.equal(passar(mw, { aal: "aal2" }), null, "com aal2 passa");
  const e = passar(mw, { aal: "aal1" });
  assert.equal(e.statusCode, 401);
  assert.equal(e.details?.codigo, "MFA_REQUERIDA");
});

test("exigirMfaSeExigido('painelAdministrativo') DESLIGADO: no-op (passa com aal1)", () => {
  const mw = exigirMfaSeExigido("painelAdministrativo");
  assert.equal(passar(mw, { aal: "aal1" }), null);
  assert.equal(passar(mw, { aal: null }), null);
  assert.equal(passar(mw, {}), null);
});

test("a mensagem do 401 não vaza detalhe sensível", () => {
  const e = passar(requireAAL2, {});
  assert.match(e.message, /duas etapas|MFA/i);
  assert.doesNotMatch(e.message, /token|jwt|secret|aal2/i);
});
