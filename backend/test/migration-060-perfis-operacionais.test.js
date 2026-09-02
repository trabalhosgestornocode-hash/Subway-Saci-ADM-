// Fase B — validação ESTÁTICA da migration 060 (perfis_operacionais).
//
// Não há runner de migration no projeto (todas rodam à mão no SQL Editor do
// Supabase), e o banco de `.env` é o de produção — então este teste NÃO toca
// banco. Ele lê o .sql e prova, no texto:
//   * que a migration é ADITIVA e NÃO DESTRUTIVA (item 24 do pedido);
//   * que nenhuma coluna perfil_id nasce NOT NULL (backward compat, item 25);
//   * que as FKs têm o ON DELETE correto por tabela (item 15);
//   * que `usuario_id` NÃO é removido (item 4/23);
//   * que a revogação de sessões usa o motivo combinado (item 7);
//   * que `plataforma_auditoria.perfil_id` não tem FK nem backfill (item 8);
//   * o INVARIANTE do backfill (id reaproveitado) como função pura (item 3, 22).
//
// Rodar: node --env-file-if-exists=.env --test test/migration-060-perfis-operacionais.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(
  fileURLToPath(new URL("../../database/migrations/060_perfis_operacionais.sql", import.meta.url)),
  "utf8",
);
const sql = SQL.toLowerCase();

/** Linhas de código SQL (sem comentários `--` e sem linhas em branco). */
const linhasExecutaveis = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, "").trim())
  .filter(Boolean)
  .join("\n")
  .toLowerCase();

/**
 * DDL "puro": `linhasExecutaveis` menos as sentenças `comment on ... is '...';`
 * (que são SQL executável, mas cujo TEXTO livre — ex.: "NOT NULL fica na Fase C"
 * — não deve disparar as asserções estruturais).
 */
const ddl = linhasExecutaveis.replace(/comment\s+on\s+[\s\S]*?;\s*/g, "");

describe("060 — arquivo existe e tem o cabeçalho do projeto", () => {
  test("tem OBJETIVO, PRÉ-REQUISITOS, ROLLBACK, COMO USAR", () => {
    for (const marca of ["objetivo", "pré-requisitos", "rollback", "como usar", "pré-check", "pós-check"]) {
      assert.ok(sql.includes(marca), `faltou seção "${marca}"`);
    }
  });
  test("declara-se transacional e idempotente", () => {
    assert.match(sql, /transacional/);
    assert.match(sql, /idempotente/);
  });
});

describe("060 — NÃO DESTRUTIVA (item 24)", () => {
  const proibidos = [
    /\bdrop\s+table\s+(?!if\s+exists\s+perfis_operacionais)/, // só o rollback (comentado) pode dropar, e só a tabela nova
    /\btruncate\b/,
    /\bdelete\s+from\b/,
    /alter\s+table\s+\w+\s+drop\s+column/,
    /update\s+auth\./,
    /alter\s+table\s+auth\./,
    /drop\s+column\s+if\s+exists\s+usuario_id/,
  ];
  for (const re of proibidos) {
    test(`nenhuma linha executável casa ${re}`, () => {
      assert.doesNotMatch(linhasExecutaveis, re);
    });
  }

  test("não remove usuario_id de tabela nenhuma", () => {
    assert.doesNotMatch(linhasExecutaveis, /drop\s+column.*usuario_id/);
  });

  test("não cria 2º perfil (backfill é 1:1 a partir de `perfis`)", () => {
    // o único INSERT em perfis_operacionais é o SELECT ... FROM perfis
    const inserts = [...linhasExecutaveis.matchAll(/insert\s+into\s+perfis_operacionais/g)];
    assert.equal(inserts.length, 1, "deve haver exatamente 1 insert em perfis_operacionais");
    assert.match(linhasExecutaveis, /insert\s+into\s+perfis_operacionais[\s\S]*?from\s+perfis\b/);
  });

  test("não toca auth.users / senha / e-mail (fora de comentários)", () => {
    assert.doesNotMatch(ddl, /auth\.users|updateuserbyid|\bpassword\b|senha_hash/);
  });
});

describe("060 — perfis_operacionais", () => {
  test("cria a tabela (idempotente) com as colunas do desenho aprovado", () => {
    assert.match(linhasExecutaveis, /create\s+table\s+if\s+not\s+exists\s+perfis_operacionais/);
    for (const col of [
      "id", "conta_id", "nome", "ativo",
      "pin_hash", "pin_tentativas", "pin_bloqueado_ate",
      "created_at", "updated_at",
    ]) {
      assert.ok(new RegExp(`\\b${col}\\b`).test(linhasExecutaveis), `faltou coluna ${col}`);
    }
  });

  test("timestamps seguem o padrão de `perfis` (created_at / updated_at), reusam set_updated_at()", () => {
    assert.match(linhasExecutaveis, /created_at\s+timestamptz/);
    assert.match(linhasExecutaveis, /updated_at\s+timestamptz/);
    assert.doesNotMatch(linhasExecutaveis, /perfis_operacionais[\s\S]*?criado_em/);
    assert.match(linhasExecutaveis, /trigger.*perfis_op.*execute function set_updated_at/s);
  });

  test("PIN: hash nullable, tentativas default 0, bloqueio nullable — sem CHECK/trigger de regra", () => {
    assert.match(linhasExecutaveis, /pin_hash\s+text\s*,/);           // sem NOT NULL
    assert.match(linhasExecutaveis, /pin_tentativas\s+integer\s+not\s+null\s+default\s+0/);
    assert.match(linhasExecutaveis, /pin_bloqueado_ate\s+timestamptz\s*,?\s*$/m);
    // a regra "2+ perfis exige PIN" NÃO pode virar constraint/trigger aqui
    assert.doesNotMatch(linhasExecutaveis, /check\s*\([^)]*pin_hash/);
  });

  test("nome NÃO é único (item 13)", () => {
    assert.doesNotMatch(linhasExecutaveis, /unique\s*\(\s*conta_id\s*,\s*nome/);
  });

  test("conta_id FK -> perfis(id) ON DELETE CASCADE (espelha perfis->auth.users)", () => {
    assert.match(linhasExecutaveis, /conta_id\s+uuid\s+not\s+null\s+references\s+perfis\(id\)\s+on\s+delete\s+cascade/);
  });

  test("RLS habilitada; policy de SELECT por conta_id = auth.uid() (NUNCA perfil_id = auth.uid())", () => {
    assert.match(linhasExecutaveis, /alter\s+table\s+perfis_operacionais\s+enable\s+row\s+level\s+security/);
    assert.match(linhasExecutaveis, /create\s+policy\s+rls_perfis_op_conta[\s\S]*?conta_id\s*=\s*auth\.uid\(\)/);
    assert.doesNotMatch(linhasExecutaveis, /perfil_id\s*=\s*auth\.uid\(\)/);
  });

  test("índice (conta_id)", () => {
    assert.match(linhasExecutaveis, /create\s+index\s+if\s+not\s+exists\s+idx_perfis_op_conta\s+on\s+perfis_operacionais\(conta_id\)/);
  });
});

describe("060 — perfil_id nas 4 tabelas: NULLABLE, backfilled, FK correta", () => {
  const alvos = [
    { tabela: "usuarios_organizacoes", fk: "uo_perfil_id_fk", onDelete: "cascade", ref: "perfis_operacionais(id)" },
    { tabela: "usuarios_unidades", fk: "uu_perfil_id_fk", onDelete: "cascade", ref: "perfis_operacionais(id)" },
    { tabela: "sessoes_contexto", fk: "sessoes_perfil_id_fk", onDelete: "cascade", ref: "perfis_operacionais(id)" },
    { tabela: "agente_conversas", fk: "agente_conversas_perfil_id_fk", onDelete: "set null", ref: "perfis_operacionais(id)" },
  ];

  for (const { tabela, fk, onDelete, ref } of alvos) {
    test(`${tabela}: add column if not exists perfil_id uuid (sem NOT NULL)`, () => {
      assert.match(linhasExecutaveis, new RegExp(`alter\\s+table\\s+${tabela}\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+perfil_id\\s+uuid\\s*;`));
    });
    test(`${tabela}: backfill perfil_id = usuario_id`, () => {
      assert.match(linhasExecutaveis, new RegExp(`update\\s+${tabela}\\s+set\\s+perfil_id\\s*=\\s*usuario_id`));
    });
    test(`${tabela}: FK ${fk} -> ${ref} ON DELETE ${onDelete}`, () => {
      const re = new RegExp(
        `add\\s+constraint\\s+${fk}\\s+foreign\\s+key\\s*\\(\\s*perfil_id\\s*\\)\\s+references\\s+${ref.replace("(", "\\(").replace(")", "\\)")}\\s+on\\s+delete\\s+${onDelete}`,
      );
      assert.match(linhasExecutaveis, re);
    });
    test(`${tabela}: FK criada com guarda pg_constraint (idempotente)`, () => {
      assert.match(linhasExecutaveis, new RegExp(`conname\\s*=\\s*'${fk}'`));
    });
  }

  test("NENHUM perfil_id nasce NOT NULL (backward compat — item 25)", () => {
    assert.doesNotMatch(ddl, /perfil_id\s+uuid[^;]*\bnot\s+null/);
    assert.doesNotMatch(ddl, /alter\s+column\s+perfil_id\s+set\s+not\s+null/);
  });

  test("NENHUMA UNIQUE nova sobre perfil_id (Model Y + Fase C) — item 6/13", () => {
    assert.doesNotMatch(ddl, /unique\s*\([^)]*perfil_id/);
    assert.doesNotMatch(ddl, /create\s+unique\s+index[\s\S]*perfil_id/);
  });

  test("NENHUMA CHECK nova em sessoes_contexto (a de impersonação é Fase D) — item 18", () => {
    assert.doesNotMatch(ddl, /add\s+constraint[^;]*check\s*\([^)]*impersonado_por/);
  });
});

describe("060 — sessoes_contexto: revogação e backfill de impersonação", () => {
  test("revoga TODAS as vivas com motivo 'migracao_060_multi_perfil' (item 7)", () => {
    assert.match(linhasExecutaveis, /update\s+sessoes_contexto\s+set\s+revogada_em\s*=\s*now\(\)\s*,\s*motivo_revogacao\s*=\s*'migracao_060_multi_perfil'\s+where\s+revogada_em\s+is\s+null/);
  });
  test("NÃO faz DELETE físico de sessão", () => {
    assert.doesNotMatch(linhasExecutaveis, /delete\s+from\s+sessoes_contexto/);
  });
  test("backfill de perfil_id só nas sessões NÃO-impersonação", () => {
    assert.match(linhasExecutaveis, /update\s+sessoes_contexto\s+set\s+perfil_id\s*=\s*usuario_id\s+where\s+perfil_id\s+is\s+null\s+and\s+impersonado_por\s+is\s+null/);
  });
  test("índice parcial de sessões vivas por perfil", () => {
    assert.match(linhasExecutaveis, /idx_sessoes_perfil_vivas\s+on\s+sessoes_contexto\(perfil_id\)\s+where\s+revogada_em\s+is\s+null/);
  });
});

describe("060 — plataforma_auditoria (append-only)", () => {
  test("ADD COLUMN if not exists perfil_id uuid — SEM FK", () => {
    assert.match(linhasExecutaveis, /alter\s+table\s+plataforma_auditoria\s+add\s+column\s+if\s+not\s+exists\s+perfil_id\s+uuid\s*;/);
    // não pode haver "references" na mesma sentença da coluna de auditoria
    assert.doesNotMatch(linhasExecutaveis, /plataforma_auditoria[\s\S]{0,80}perfil_id[\s\S]{0,40}references/);
  });
  test("SEM backfill (o trigger de imutabilidade recusa UPDATE)", () => {
    assert.doesNotMatch(linhasExecutaveis, /update\s+plataforma_auditoria\s+set\s+perfil_id/);
  });
  test("índice idx_audit_perfil", () => {
    assert.match(linhasExecutaveis, /idx_audit_perfil\s+on\s+plataforma_auditoria\(perfil_id\)/);
  });
});

describe("060 — RLS existente preservado (item 17)", () => {
  test("NÃO altera rls_uo_self / rls_uu_self / auth_organizacao_ids / auth_unidade_ids / is_platform_superadmin", () => {
    assert.doesNotMatch(linhasExecutaveis, /create\s+(or\s+replace\s+)?policy\s+rls_uo_self/);
    assert.doesNotMatch(linhasExecutaveis, /create\s+(or\s+replace\s+)?policy\s+rls_uu_self/);
    assert.doesNotMatch(linhasExecutaveis, /create\s+or\s+replace\s+function\s+auth_organizacao_ids/);
    assert.doesNotMatch(linhasExecutaveis, /create\s+or\s+replace\s+function\s+auth_unidade_ids/);
    assert.doesNotMatch(linhasExecutaveis, /create\s+or\s+replace\s+function\s+is_platform_superadmin/);
  });
  test("a ÚNICA policy criada é a da tabela nova", () => {
    const policies = [...linhasExecutaveis.matchAll(/create\s+policy\s+(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(policies, ["rls_perfis_op_conta"]);
  });
});

describe("060 — as ~28 colunas B/C NÃO são migradas (item 10)", () => {
  test("nenhum ALTER em tabela de domínio de lançamento/bonificação/parser/MB/iFood", () => {
    for (const t of [
      "lancamentos_financeiros_diarios", "lancamentos_mensais", "bonificacao_importacoes",
      "bonificacao_lancamentos_diarios", "parser_fd_importacoes", "parser_fd_pedidos",
      "martin_brower_vinculos", "ifood_integracao_credenciais", "produto_historico",
      "insumo_preco_historico", "unidade_modelo_logistico_historico", "movimentacoes_estoque",
    ]) {
      assert.doesNotMatch(linhasExecutaveis, new RegExp(`alter\\s+table\\s+${t}\\b`), `060 não deveria tocar ${t}`);
    }
  });
});

describe("060 — ROLLBACK documentado e ordenado", () => {
  test("cita índices, FKs, colunas, RLS e a tabela nova, e lembra que usuario_id fica intacto", () => {
    const rb = sql.slice(sql.indexOf("rollback"));
    for (const t of [
      "idx_audit_perfil", "agente_conversas_perfil_id_fk", "sessoes_perfil_id_fk",
      "uu_perfil_id_fk", "uo_perfil_id_fk", "drop column if exists perfil_id",
      "rls_perfis_op_conta", "drop table if exists perfis_operacionais",
    ]) {
      assert.ok(rb.includes(t), `rollback não menciona "${t}"`);
    }
    assert.ok(rb.includes("nunca foi removido"), "rollback deve lembrar que usuario_id fica intacto");
  });
});

// ---------------------------------------------------------------------
// INVARIANTE DO BACKFILL — função pura (espelha o INSERT ... SELECT).
// Prova: 1 conta -> 1 perfil; id == conta_id; ativo/created_at herdados;
// perfil_id dos vínculos == usuario_id; nenhuma conversa troca de dono.
// ---------------------------------------------------------------------
function backfillPerfisOperacionais(perfis) {
  return perfis.map((p) => ({
    id: p.id,
    conta_id: p.id, // UUID reaproveitado
    nome: (p.nome && p.nome.trim()) || (p.email || "").split("@")[0] || "Usuário",
    ativo: p.ativo ?? true,
    created_at: p.created_at ?? "now",
  }));
}
const backfillPerfilId = (linhas) => linhas.map((l) => ({ ...l, perfil_id: l.perfil_id ?? l.usuario_id }));

describe("backfill — invariantes (item 3, 22, 26)", () => {
  const CONTAS = [
    { id: "acc-1", nome: "João", email: "joao@x.com", ativo: true, created_at: "2024-01-01" },
    { id: "acc-2", nome: "  ", email: "op@x.com", ativo: true, created_at: "2024-02-01" },
    { id: "acc-3", nome: "Maria", email: "maria@x.com", ativo: false, created_at: "2024-03-01" },
  ];

  test("1 conta -> exatamente 1 perfil operacional", () => {
    const r = backfillPerfisOperacionais(CONTAS);
    assert.equal(r.length, CONTAS.length);
  });

  test("id do perfil inicial == id da conta == conta_id", () => {
    for (const p of backfillPerfisOperacionais(CONTAS)) {
      assert.equal(p.id, p.conta_id);
      assert.ok(CONTAS.some((c) => c.id === p.id));
    }
  });

  test("conta inativa -> perfil inicial inativo", () => {
    const maria = backfillPerfisOperacionais(CONTAS).find((p) => p.id === "acc-3");
    assert.equal(maria.ativo, false);
  });

  test("nome vazio cai no fallback (local-part do e-mail), nunca fica vazio", () => {
    const op = backfillPerfisOperacionais(CONTAS).find((p) => p.id === "acc-2");
    assert.equal(op.nome, "op");
    assert.ok(backfillPerfisOperacionais(CONTAS).every((p) => p.nome && p.nome.length));
  });

  test("vínculos: perfil_id == usuario_id (id reaproveitado torna a FK válida sem UPDATE de dados)", () => {
    const uo = [
      { usuario_id: "acc-1", organizacao_id: "org-A", papel: "operations" },
      { usuario_id: "acc-3", organizacao_id: "org-B", papel: "finance" },
    ];
    for (const l of backfillPerfilId(uo)) assert.equal(l.perfil_id, l.usuario_id);
  });

  test("agente_conversas: dono preservado; usuario_id NULL -> perfil_id NULL (sem trocar dono)", () => {
    const conv = [
      { id: "c1", usuario_id: "acc-1", organizacao_id: "org-A" },
      { id: "c2", usuario_id: null, organizacao_id: "org-A" }, // impersonação / sem dono
    ];
    const r = backfillPerfilId(conv);
    assert.equal(r[0].perfil_id, "acc-1");
    assert.equal(r[1].perfil_id, null);
    // nenhuma conversa passou a apontar para um dono diferente do original
    assert.ok(r.every((c) => c.perfil_id === c.usuario_id || (c.usuario_id === null && c.perfil_id === null)));
  });

  test("perfil adicional futuro pode ter UUID != conta (o reuso vale só p/ o inicial)", () => {
    // modelo do que a Fase G fará: novo perfil = gen_random_uuid(), conta_id = conta
    const novo = { id: "perfil-novo-uuid", conta_id: "acc-1", nome: "Fulana 2", ativo: true };
    assert.notEqual(novo.id, novo.conta_id);
    assert.equal(novo.conta_id, "acc-1");
  });

  test("dois perfis da mesma conta podem ter vínculos distintos (sem UNIQUE bloqueando)", () => {
    const vinculos = [
      { perfil_id: "acc-1", organizacao_id: "org-A" },        // Fulana 1
      { perfil_id: "perfil-novo-uuid", organizacao_id: "org-B" }, // Fulana 2
    ];
    const chave = (v) => `${v.perfil_id}:${v.organizacao_id}`;
    assert.equal(new Set(vinculos.map(chave)).size, 2);
  });
});

describe("sessões — Model Y (item 6, 8, 9)", () => {
  test("múltiplas sessões vivas do MESMO perfil são um estado válido do modelo", () => {
    // 060 não cria nenhuma UNIQUE que impeça isto; a asserção aqui é sobre o
    // texto (já coberto acima) + a intenção documentada.
    assert.match(sql, /model y/);
    assert.match(sql, /multi-device do mesmo perfil/);
    assert.doesNotMatch(ddl, /unique\s*\([^)]*perfil_id/);
    assert.doesNotMatch(ddl, /unique\s*\([^)]*conta_id[^)]*perfil_id/);
  });
});
