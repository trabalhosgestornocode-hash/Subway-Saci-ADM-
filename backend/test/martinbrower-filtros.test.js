import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizarCatalogo } from "../src/modules/martinbrower/martinbrower.normalizer.js";
import { aplicarFiltros, criarFiltro, normalizarTexto } from "../src/modules/martinbrower/martinbrower.filtros.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const CATALOGO = JSON.parse(readFileSync(join(aqui, "fixtures/martinbrower/load-itens.json"), "utf8"));

const prod = (over = {}) => ({
  codigo: "1", descricao: "PRODUTO", familia: "DIV", familiaDescricao: "Diversos",
  grupoDescricao: "DIVERSOS", ...over,
});

test("uniformes e vestuário são ignorados; alimentos e embalagens passam", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const { produtos: classificados, validos, ignorados } = aplicarFiltros(produtos);

  assert.equal(validos, 4);   // bacon, frango, guardanapo, copo
  assert.equal(ignorados, 2); // camiseta polo, avental

  const porCodigo = Object.fromEntries(classificados.map((p) => [p.codigo, p]));
  assert.equal(porCodigo["1001088"].ignorado, false, "bacon é alimento");
  assert.equal(porCodigo["0002045"].ignorado, false, "guardanapo é embalagem");
  assert.equal(porCodigo["5000101"].ignorado, true, "camiseta é uniforme");
  assert.equal(porCodigo["5000101"].regraIgnorado, "padrao:familia");
  assert.equal(porCodigo["5000102"].ignorado, true, "avental é vestuário");
  assert.equal(porCodigo["5000102"].regraIgnorado, "padrao:palavra_chave");
});

test("nada é REMOVIDO — a lista completa é preservada com a classificação", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const { produtos: classificados } = aplicarFiltros(produtos);
  assert.equal(classificados.length, produtos.length);
  for (const p of classificados) {
    assert.ok("ignorado" in p && "motivoIgnorado" in p && "regraIgnorado" in p);
  }
});

test("todo item ignorado carrega motivo e regra auditáveis", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const { produtos: classificados } = aplicarFiltros(produtos);
  for (const p of classificados.filter((x) => x.ignorado)) {
    assert.ok(p.motivoIgnorado?.length > 0, `${p.codigo} sem motivo`);
    assert.ok(p.regraIgnorado?.length > 0, `${p.codigo} sem regra`);
  }
});

test("acentos e caixa não escapam do filtro", () => {
  const f = criarFiltro();
  assert.equal(f.classificar(prod({ descricao: "Calça Jeans Preta" })).ignorado, true);
  assert.equal(f.classificar(prod({ descricao: "BONÉ SUBWAY" })).ignorado, true);
  assert.equal(f.classificar(prod({ descricao: "boné subway" })).ignorado, true);
});

test("casa palavra inteira — não gera falso positivo dentro de outra palavra", () => {
  const f = criarFiltro();
  assert.equal(f.classificar(prod({ descricao: "MOLHO BARBECUE GALAO 3L" })).ignorado, false);
  assert.equal(f.classificar(prod({ descricao: "CEBOLA ROXA KG" })).ignorado, false);
  // "bone" não pode casar dentro de "carbonell"; "bota" não pode casar em "garrafa".
  assert.equal(f.classificar(prod({ descricao: "AZEITE CARBONELL 500ML" })).ignorado, false);
  assert.equal(f.classificar(prod({ descricao: "GARRAFA PET 600ML" })).ignorado, false);
});

test("produtos operacionais que SOAM vestuário não são ignorados por engano", () => {
  const f = criarFiltro();
  // Falsos positivos que a lista padrão precisa evitar — todos itens reais.
  assert.equal(f.classificar(prod({ descricao: "PAO MEIA LUA CX 50 UN" })).ignorado, false, "pão meia lua é alimento");
  assert.equal(f.classificar(prod({ descricao: "TOUCA DESCARTAVEL PCT 100 UN" })).ignorado, false, "touca descartável é EPI");
  assert.equal(f.classificar(prod({ descricao: "LUVA DESCARTAVEL M PCT 100" })).ignorado, false, "luva descartável é EPI");
  // ...mas luva de malha (uniforme) continua sendo ignorada.
  assert.equal(f.classificar(prod({ descricao: "LUVA DE MALHA PIGMENTADA" })).ignorado, true);
});

test("regra 'incluir' do administrador vence o filtro padrão", () => {
  const f = criarFiltro([{ tipo: "codigo", valor: "5000102", acao: "incluir" }]);
  const r = f.classificar(prod({ codigo: "5000102", descricao: "AVENTAL PRETO SUBWAY" }));
  assert.equal(r.ignorado, false);
  assert.equal(r.regra, "custom:incluir:codigo");
});

test("regra custom de exclusão por grupo, família, descrição e código", () => {
  const casos = [
    [{ tipo: "grupo", valor: "BEBIDAS", acao: "ignorar" }, prod({ grupoDescricao: "BEBIDAS GELADAS" })],
    [{ tipo: "familia", valor: "QUI", acao: "ignorar" }, prod({ familia: "QUI" })],
    [{ tipo: "descricao", valor: "amostra", acao: "ignorar" }, prod({ descricao: "KIT AMOSTRA GRATIS" })],
    [{ tipo: "codigo", valor: "9999", acao: "ignorar" }, prod({ codigo: "9999" })],
  ];
  for (const [regra, produto] of casos) {
    const r = criarFiltro([regra]).classificar(produto);
    assert.equal(r.ignorado, true, `regra ${regra.tipo} deveria ignorar`);
    assert.equal(r.regra, `custom:ignorar:${regra.tipo}`);
  }
});

test("motivo customizado do administrador é preservado", () => {
  const f = criarFiltro([{ tipo: "codigo", valor: "9999", acao: "ignorar", motivo: "Descontinuado pela franquia" }]);
  assert.equal(f.classificar(prod({ codigo: "9999" })).motivo, "Descontinuado pela franquia");
});

test("normalizarTexto remove acentos e colapsa espaços", () => {
  assert.equal(normalizarTexto("  ÁVENTAL   Preto  "), "aventaol preto".replace("aventaol", "avental"));
  assert.equal(normalizarTexto(null), "");
});

test("regra malformada é ignorada sem quebrar o filtro", () => {
  const f = criarFiltro([{ tipo: null, valor: "x" }, { valor: "y" }, {}, null]);
  assert.equal(f.classificar(prod({ descricao: "BACON" })).ignorado, false);
});
