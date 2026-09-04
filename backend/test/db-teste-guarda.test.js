// Testa a guarda de banco de TESTE (helper de conexão PG direta).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MSG_ABORTO,
  urlBancoDeTeste,
  hostDe,
  parecePlaceholder,
  pareceProducao,
  assertBancoDeTeste,
} from "./helpers/db-teste.js";

const TESTE = "postgresql://postgres:S3nh4Real@db.projteste.supabase.co:5432/postgres";
const PROD = "postgresql://postgres:x@db.projprod.supabase.co:5432/postgres";

describe("guarda de banco de teste", () => {
  it("aborta com mensagem contratual quando DATABASE_TESTE_URL ausente", () => {
    assert.equal(urlBancoDeTeste({}), null);
    assert.throws(() => assertBancoDeTeste({}), (e) => e.message === MSG_ABORTO);
  });

  it("aceita o nome legado DATABASETESTE_URL", () => {
    assert.equal(urlBancoDeTeste({ DATABASETESTE_URL: TESTE }), TESTE);
  });

  it("prefere DATABASE_TESTE_URL sobre o legado", () => {
    assert.equal(
      urlBancoDeTeste({ DATABASE_TESTE_URL: TESTE, DATABASETESTE_URL: PROD }),
      TESTE
    );
  });

  it("detecta senha placeholder [YOUR-PASSWORD] e variações", () => {
    assert.equal(parecePlaceholder("postgresql://postgres:[YOUR-PASSWORD]@h:5432/d"), true);
    assert.equal(parecePlaceholder("postgresql://postgres:[S3nh4]@h:5432/d"), true);
    assert.equal(parecePlaceholder("postgresql://postgres:SUA_SENHA@h:5432/d"), true);
    assert.equal(parecePlaceholder("postgresql://postgres:changeme@h:5432/d"), true);
    assert.equal(parecePlaceholder(TESTE), false);
  });

  it("recusa quando o host coincide com produção (SUPABASE_URL ou DATABASE_URL)", () => {
    const env = { DATABASE_TESTE_URL: PROD, DATABASE_URL: PROD };
    assert.equal(pareceProducao(PROD, env), true);
    assert.throws(() => assertBancoDeTeste(env), /produção/);

    const env2 = {
      DATABASE_TESTE_URL: PROD,
      SUPABASE_URL: "https://projprod.supabase.co",
    };
    assert.equal(pareceProducao(PROD, env2), true);
  });

  it("NUNCA cai para DATABASE_URL quando DATABASE_TESTE_URL falta", () => {
    const env = { DATABASE_URL: PROD };
    assert.equal(urlBancoDeTeste(env), null);
    assert.throws(() => assertBancoDeTeste(env), (e) => e.message === MSG_ABORTO);
  });

  it("passa e devolve host quando a URL de teste é válida e distinta", () => {
    const env = { DATABASE_TESTE_URL: TESTE, DATABASE_URL: PROD };
    const r = assertBancoDeTeste(env);
    assert.equal(r.host, "db.projteste.supabase.co");
  });

  it("hostDe parseia URL malformada por regex", () => {
    assert.equal(hostDe("postgres://u:p@meu-host:5432/db"), "meu-host");
    assert.equal(hostDe(""), "");
  });
});
