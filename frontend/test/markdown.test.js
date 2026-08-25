// Testes do renderer de Markdown seguro do Agente Crescer (frontend/src/markdown.js).
//
// Sem framework de frontend no projeto (ES modules puros, sem bundler) —
// roda com o test runner nativo do Node, igual ao backend. As funções
// testadas aqui não tocam DOM (só string), então funcionam sob Node puro.
//
// Rodar: node --test frontend/test/markdown.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderizarMarkdownSeguro } from "../src/markdown.js";

describe("renderizarMarkdownSeguro — segurança (XSS)", () => {
  test("<script> vira texto literal, nunca uma tag real", () => {
    const html = renderizarMarkdownSeguro("<script>alert(1)</script>");
    assert.ok(!/<script/i.test(html), `HTML não deveria conter <script>: ${html}`);
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("atributo de evento inline (onerror) nunca vira atributo real", () => {
    const html = renderizarMarkdownSeguro('<img src=x onerror="alert(1)">');
    assert.ok(!/<img/i.test(html));
    assert.ok(html.includes("&lt;img"));
  });

  test("markdown malicioso (link javascript:) não vira <a> — link não é suportado", () => {
    const html = renderizarMarkdownSeguro("[clique](javascript:alert(1))");
    assert.ok(!/<a /i.test(html));
  });

  test("tentativa de fechar a tag <strong> e injetar script permanece inerte", () => {
    const html = renderizarMarkdownSeguro("**bold</strong><script>alert(1)</script>**");
    assert.ok(!/<script>/i.test(html));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});

describe("renderizarMarkdownSeguro — formatação", () => {
  test("negrito", () => {
    assert.equal(renderizarMarkdownSeguro("**R$ 24.876,00**"), "<strong>R$ 24.876,00</strong>");
  });

  test("itálico", () => {
    assert.equal(renderizarMarkdownSeguro("*atenção*"), "<em>atenção</em>");
  });

  test("código inline", () => {
    assert.equal(renderizarMarkdownSeguro("use `consultar_dashboard_dia`"), "use <code>consultar_dashboard_dia</code>");
  });

  test("lista simples", () => {
    const html = renderizarMarkdownSeguro("- item um\n- item dois");
    assert.equal(html, "<ul><li>item um</li><li>item dois</li></ul>");
  });

  test("título simples (#) vira destaque, não <h1> real", () => {
    const html = renderizarMarkdownSeguro("### Resumo do mês");
    assert.ok(html.includes('<strong class="md-titulo">Resumo do mês</strong>'));
  });

  test("quebras de linha viram <br>", () => {
    const html = renderizarMarkdownSeguro("linha 1\nlinha 2");
    assert.equal(html, "linha 1<br>linha 2");
  });

  test("texto puro sem marcação passa direto (escapado)", () => {
    assert.equal(renderizarMarkdownSeguro("Faturamento: R$ 100,00"), "Faturamento: R$ 100,00");
  });
});
