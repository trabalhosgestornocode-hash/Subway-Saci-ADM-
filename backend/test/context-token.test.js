// Testes do Context Token — a peça que sustenta o isolamento multiempresa.
//
// O que estes testes protegem: se a verificação do token puder ser burlada, um
// tenant lê os dados de outro. Cada caso abaixo é uma forma concreta de tentar
// isso (assinatura trocada, payload adulterado, token expirado, empresa
// diferente da assinada) e a asserção é sempre a mesma: NÃO PASSA.
//
// Rodar: node --env-file-if-exists=.env --test test/context-token.test.js
// (O env é necessário porque config/env.js exige as chaves do Supabase — nenhum
//  teste aqui faz rede.)

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { emitirContextToken, verificarContextToken, VALIDADE_PADRAO_S } from "../src/shared/contextToken.js";
import { permissoesDoPapel, temPermissao, papelValido, PAPEIS_VINCULO, PERMISSOES } from "../src/shared/permissoes.js";
import { exigirSenhaDefinitiva } from "../src/middlewares/auth.js";
import * as v from "../src/shared/validar.js";

const BASE = {
  usuarioId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  organizacaoId: "33333333-3333-4333-8333-333333333333",
  unidadeId: null,
  papel: "organization_admin",
  permissoes: ["dashboard.ver"],
};

/** Reconstrói um token trocando campos do payload, mantendo a assinatura original. */
function adulterarPayload(token, mudancas) {
  const [corpo, assinatura] = token.split(".");
  const payload = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
  const novo = Buffer.from(JSON.stringify({ ...payload, ...mudancas })).toString("base64url");
  return `${novo}.${assinatura}`;
}

describe("contextToken — emissão", () => {
  test("emite token verificável com o payload informado", () => {
    const { token, expiraEm } = emitirContextToken(BASE);
    const r = verificarContextToken(token);

    assert.equal(r.ok, true);
    assert.equal(r.payload.sub, BASE.usuarioId);
    assert.equal(r.payload.sid, BASE.sessionId);
    assert.equal(r.payload.cid, BASE.organizacaoId);
    assert.equal(r.payload.uid, null);
    assert.equal(r.payload.role, "organization_admin");
    assert.equal(r.payload.imp, null);
    assert.ok(expiraEm instanceof Date);
  });

  test("respeita a validade informada", () => {
    const { token } = emitirContextToken({ ...BASE, validadeS: 60 });
    const r = verificarContextToken(token);
    const duracao = r.payload.exp - r.payload.iat;
    assert.equal(duracao, 60);
  });

  test("validade padrão é de 8 horas", () => {
    assert.equal(VALIDADE_PADRAO_S, 8 * 60 * 60);
  });

  test("marca impersonação quando informada", () => {
    const { token } = emitirContextToken({ ...BASE, impersonadoPor: BASE.usuarioId });
    assert.equal(verificarContextToken(token).payload.imp, BASE.usuarioId);
  });
});

describe("contextToken — verificação recusa o que deve recusar", () => {
  test("token ausente ou vazio", () => {
    for (const entrada of [null, undefined, "", "  ", 42, {}]) {
      assert.equal(verificarContextToken(entrada).ok, false);
    }
  });

  test("token sem separador", () => {
    assert.equal(verificarContextToken("semponto").ok, false);
  });

  test("assinatura trocada", () => {
    const { token } = emitirContextToken(BASE);
    const [corpo] = token.split(".");
    const falso = `${corpo}.${Buffer.from("assinatura-inventada").toString("base64url")}`;
    const r = verificarContextToken(falso);
    assert.equal(r.ok, false);
  });

  test("payload adulterado invalida a assinatura (troca de empresa)", () => {
    // Este é O ataque que o desenho previne: pegar um token legítimo e trocar
    // o company_id para ler os dados de outra empresa.
    const { token } = emitirContextToken(BASE);
    const outraEmpresa = "44444444-4444-4444-8444-444444444444";
    const r = verificarContextToken(adulterarPayload(token, { cid: outraEmpresa }));
    assert.equal(r.ok, false);
    assert.match(r.motivo, /inválido/i);
  });

  test("payload adulterado invalida a assinatura (troca de papel)", () => {
    const { token } = emitirContextToken({ ...BASE, papel: "viewer", permissoes: ["dashboard.ver"] });
    const r = verificarContextToken(adulterarPayload(token, {
      role: "organization_admin", perms: Object.values(PERMISSOES),
    }));
    assert.equal(r.ok, false);
  });

  test("prolongar a expiração invalida a assinatura", () => {
    const { token } = emitirContextToken({ ...BASE, validadeS: 60 });
    const r = verificarContextToken(adulterarPayload(token, {
      exp: Math.floor(Date.now() / 1000) + 999_999,
    }));
    assert.equal(r.ok, false);
  });

  test("token expirado", () => {
    // validadeS negativa produz um token já vencido, com assinatura VÁLIDA —
    // é o caminho para testar a checagem de expiração isoladamente.
    const { token } = emitirContextToken({ ...BASE, validadeS: -10 });
    const r = verificarContextToken(token);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /expirad/i);
  });

  test("versão de formato diferente", () => {
    const { token } = emitirContextToken(BASE);
    // Adulterar `v` quebra a assinatura antes de chegar na checagem de versão,
    // então o token é recusado de todo modo — que é o comportamento correto.
    assert.equal(verificarContextToken(adulterarPayload(token, { v: 99 })).ok, false);
  });

  test("base64 inválido no corpo", () => {
    assert.equal(verificarContextToken("!!!!.@@@@").ok, false);
  });

  test("um caractere alterado na assinatura já invalida", () => {
    const { token } = emitirContextToken(BASE);
    const [corpo, assinatura] = token.split(".");
    const trocado = (assinatura[0] === "A" ? "B" : "A") + assinatura.slice(1);
    assert.equal(verificarContextToken(`${corpo}.${trocado}`).ok, false);
  });
});

describe("permissões por papel", () => {
  test("organization_admin tem todas as permissões", () => {
    const p = permissoesDoPapel("organization_admin");
    for (const permissao of Object.values(PERMISSOES)) {
      assert.ok(p.includes(permissao), `faltou ${permissao}`);
    }
  });

  test("viewer não escreve nada", () => {
    const p = permissoesDoPapel("viewer");
    assert.equal(temPermissao(p, PERMISSOES.PRODUTOS_EDITAR), false);
    assert.equal(temPermissao(p, PERMISSOES.USUARIOS_GERENCIAR), false);
    assert.equal(temPermissao(p, PERMISSOES.VENDAS_IMPORTAR), false);
    assert.equal(temPermissao(p, PERMISSOES.DASHBOARD_VER), true);
  });

  test("só organization_admin gerencia usuários", () => {
    const podem = PAPEIS_VINCULO.filter((p) =>
      temPermissao(permissoesDoPapel(p), PERMISSOES.USUARIOS_GERENCIAR));
    assert.deepEqual(podem, ["organization_admin"]);
  });

  test("papel desconhecido cai no mínimo (viewer)", () => {
    assert.deepEqual(permissoesDoPapel("inventado"), permissoesDoPapel("viewer"));
    assert.deepEqual(permissoesDoPapel(undefined), permissoesDoPapel("viewer"));
  });

  test("platform_superadmin NÃO é papel de vínculo", () => {
    assert.equal(papelValido("platform_superadmin"), false);
    assert.equal(PAPEIS_VINCULO.includes("platform_superadmin"), false);
  });

  test("permissoesDoPapel devolve cópia (não vaza a lista interna)", () => {
    const a = permissoesDoPapel("viewer");
    a.push("hackeado.tudo");
    assert.equal(permissoesDoPapel("viewer").includes("hackeado.tudo"), false);
  });

  test("temPermissao é seguro com entrada inválida", () => {
    assert.equal(temPermissao(null, "x"), false);
    assert.equal(temPermissao(undefined, "x"), false);
    assert.equal(temPermissao("nao-é-array", "x"), false);
  });
});

describe("gate de senha provisória", () => {
  /** Simula o (req,res,next) do Express capturando o que o gate faz. */
  function rodar(user) {
    let erro = "nao-chamado";
    exigirSenhaDefinitiva({ user }, {}, (e) => { erro = e ?? null; });
    return erro;
  }

  test("senha provisória bloqueia com 403 e sinaliza o motivo", () => {
    const erro = rodar({ senhaProvisoria: true });
    assert.ok(erro, "deveria bloquear");
    assert.equal(erro.statusCode, 403);
    assert.equal(erro.details?.senhaProvisoria, true);
  });

  test("senha definitiva passa", () => {
    assert.equal(rodar({ senhaProvisoria: false }), null);
  });

  test("ausência da flag não bloqueia (usuário normal)", () => {
    assert.equal(rodar({}), null);
    assert.equal(rodar({ id: "x" }), null);
  });
});

describe("validadores", () => {
  test("uuid aceita válido e recusa o resto", () => {
    assert.equal(v.uuid("33333333-3333-4333-8333-333333333333", "X"),
      "33333333-3333-4333-8333-333333333333");
    for (const ruim of ["", "abc", "33333333-3333-4333-8333", null, 1, "'; drop table--"]) {
      assert.throws(() => v.uuid(ruim, "Empresa"), /Empresa inválido/);
    }
  });

  test("email normaliza para minúsculas", () => {
    assert.equal(v.email("  JOAO@Exemplo.COM  "), "joao@exemplo.com");
    assert.throws(() => v.email("sem-arroba"), /inválido/);
    assert.throws(() => v.email(""), /obrigatório/);
  });

  test("senha exige 8 caracteres", () => {
    assert.throws(() => v.senha("1234567"), /8 caracteres/);
    assert.equal(v.senha("12345678"), "12345678");
  });

  test("umDe recusa valor fora da lista", () => {
    assert.equal(v.umDe("ativa", "Status", ["ativa", "teste"]), "ativa");
    assert.throws(() => v.umDe("outro", "Status", ["ativa", "teste"]), /Status inválido/);
  });

  test("limite satura em vez de lançar", () => {
    assert.equal(v.limite(99999, 50, 1, 500), 500);
    assert.equal(v.limite(-5, 50, 1, 500), 1);
    assert.equal(v.limite("abc", 50, 1, 500), 50);
    assert.equal(v.limite(undefined, 50, 1, 500), 50);
  });

  test("urlOpcional recusa esquemas perigosos", () => {
    assert.equal(v.urlOpcional("https://ok.com/logo.png", "Logo"), "https://ok.com/logo.png");
    assert.equal(v.urlOpcional("", "Logo"), null);
    // Uma logo com javascript: renderizada no painel seria XSS.
    assert.throws(() => v.urlOpcional("javascript:alert(1)", "Logo"), /http/);
    assert.throws(() => v.urlOpcional("data:text/html,<script>", "Logo"), /http/);
  });

  test("cnpj guarda só dígitos e exige 14", () => {
    assert.equal(v.cnpjOpcional("12.345.678/0001-95"), "12345678000195");
    assert.equal(v.cnpjOpcional(""), null);
    assert.throws(() => v.cnpjOpcional("123"), /14 dígitos/);
  });

  test("booleano interpreta as formas que chegam por query string", () => {
    assert.equal(v.booleano("true"), true);
    assert.equal(v.booleano("1"), true);
    assert.equal(v.booleano("false"), false);
    assert.equal(v.booleano("0"), false);
    assert.equal(v.booleano(undefined, true), true);
    assert.equal(v.booleano("lixo", false), false);
  });

  test("corpo recusa array e nulo", () => {
    assert.deepEqual(v.corpo({ a: 1 }), { a: 1 });
    assert.throws(() => v.corpo([]), /inválido/);
    assert.throws(() => v.corpo(null), /inválido/);
    assert.throws(() => v.corpo("texto"), /inválido/);
  });

  test("dataOpcional exige AAAA-MM-DD", () => {
    assert.equal(v.dataOpcional("2026-07-29", "Data"), "2026-07-29");
    assert.equal(v.dataOpcional("", "Data"), null);
    assert.throws(() => v.dataOpcional("29/07/2026", "Data"), /AAAA-MM-DD/);
  });
});
