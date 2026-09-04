// Regressão P0.4: `config.ifood` precisa ser populado a partir das ENV
// IFOOD_*_CLIENT_*. Antes desta correção, `config/env.js` nunca definia
// `config.ifood`, então `credenciaisDoApp()` (ifoodToken.service.js) SEMPRE
// lançava IFOOD_APP_SEM_CREDENCIAL, mesmo com as credenciais no ambiente —
// e todo o fluxo OAuth/token/merchant do iFood ficava quebrado.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-secret";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "an-id";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "an-secret";

const { config } = await import("../src/config/env.js");
const { credenciaisDoApp } = await import("../src/modules/ifood/ifoodToken.service.js");

test("config.ifood reflete as ENV IFOOD_*_CLIENT_*", () => {
  assert.deepEqual(config.ifood.financial, { clientId: "fin-id", clientSecret: "fin-secret" });
  assert.deepEqual(config.ifood.analytics, { clientId: "an-id", clientSecret: "an-secret" });
});

test("credenciaisDoApp('financial') devolve as credenciais (não lança)", () => {
  assert.deepEqual(credenciaisDoApp("financial"), { clientId: "fin-id", clientSecret: "fin-secret" });
});

test("credenciaisDoApp('analytics') devolve as credenciais (não lança)", () => {
  assert.deepEqual(credenciaisDoApp("analytics"), { clientId: "an-id", clientSecret: "an-secret" });
});
