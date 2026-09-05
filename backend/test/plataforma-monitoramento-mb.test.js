// Regressão P0.6: o monitor da Martin Brower consultava uma tabela que nunca
// existiu ("mb_sincronizacoes" — a real é "martin_brower_sincronizacoes"),
// então `ultimaSincronizacaoMb()` sempre devolvia null (erro silencioso,
// capturado pelo try/catch) e o painel de monitoramento nunca mostrava a
// sincronização de verdade.
//
// O módulo não injeta o cliente Supabase (mesmo padrão de outros serviços
// mais antigos do projeto), então a prova estática garante que a referência
// errada não volta; a suíte de integração (gated, ver preflight-integracao)
// prova contra o banco real quando houver credenciais de teste.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ARQUIVO = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "src", "modules", "plataforma", "plataforma.monitoramento.service.js"
);
const fonte = readFileSync(ARQUIVO, "utf8");

test("monitor da Martin Brower consulta martin_brower_sincronizacoes (não mb_sincronizacoes)", () => {
  assert.ok(
    fonte.includes('"martin_brower_sincronizacoes"'),
    "esperava a consulta apontando para a tabela real martin_brower_sincronizacoes"
  );
  assert.ok(
    !fonte.includes('"mb_sincronizacoes"'),
    "a tabela mb_sincronizacoes nunca existiu — não deveria mais ser referenciada"
  );
});

test("ordena por iniciado_em (não created_at, que não existe nesta tabela)", () => {
  assert.match(fonte, /martin_brower_sincronizacoes["\s\S]{0,120}iniciado_em/);
  assert.ok(!/martin_brower_sincronizacoes["\s\S]{0,120}created_at/.test(fonte));
});
