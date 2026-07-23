// Trava de acesso ao portal real.
//
// Regressão de um incidente concreto (2026-07-22): um teste de HMAC que no
// Windows parava por falta de Chromium seguiu adiante dentro do container e
// tentou logar no portal REAL. O script era o mesmo; só o ambiente mudou.
// Estes testes existem para que isso não possa acontecer de novo.
import test from "node:test";
import assert from "node:assert/strict";
import { ehPortalReal, portalRealAutorizado, HOSTS_PORTAL_REAL } from "../src/config.js";

// validarAlvoDoPortal lê MB_PORTAL_URL do módulo, que é resolvido no import.
// Para testar URL a URL usamos ehPortalReal(url), que aceita o alvo direto.
function validarUrl(url, autorizado) {
  const antes = process.env.MB_ALLOW_REAL_PORTAL;
  if (autorizado) process.env.MB_ALLOW_REAL_PORTAL = "true";
  else delete process.env.MB_ALLOW_REAL_PORTAL;
  try {
    if (ehPortalReal(url) && !portalRealAutorizado()) throw new Error("[PORTAL REAL BLOQUEADO]");
    return true;
  } finally {
    if (antes === undefined) delete process.env.MB_ALLOW_REAL_PORTAL;
    else process.env.MB_ALLOW_REAL_PORTAL = antes;
  }
}

test("reconhece o portal real da Martin Brower", () => {
  const reais = [
    "https://portal.martinbrower.com.br/",
    "https://portal.martinbrower.com.br/mbbr/portal-api/order/loadItens",
    "http://PORTAL.MARTINBROWER.COM.BR/",          // caixa alta
    "https://qualquercoisa.martinbrower.com.br/",  // subdomínio
    "https://martinbrower.com.br/",                // domínio raiz
    "https://www.martinbrower.com/",               // .com
  ];
  for (const url of reais) {
    assert.equal(ehPortalReal(url), true, `deveria reconhecer como REAL: ${url}`);
  }
});

test("NÃO confunde alvos locais e inofensivos com o portal real", () => {
  const seguros = [
    "http://127.0.0.1:9999/",
    "http://localhost:8080/",
    "http://host.docker.internal:9999/",
    "https://exemplo.test/",
    "data:text/html,<html></html>",
    "https://martinbrower.exemplo.com/",       // NÃO é subdomínio deles
    "https://naoemartinbrower.com.br/",        // sufixo parecido, domínio outro
  ];
  for (const url of seguros) {
    assert.equal(ehPortalReal(url), false, `nao deveria bloquear: ${url}`);
  }
});

test("BLOQUEIA o portal real sem MB_ALLOW_REAL_PORTAL", () => {
  assert.throws(() => validarUrl("https://portal.martinbrower.com.br/", false),
    /PORTAL REAL BLOQUEADO/, "o portal real precisa ser recusado por padrao");
});

test("PERMITE o portal real com autorização explícita", () => {
  assert.equal(validarUrl("https://portal.martinbrower.com.br/", true), true);
});

test("alvo local passa sempre, com ou sem autorização", () => {
  assert.equal(validarUrl("http://127.0.0.1:9999/", false), true);
  assert.equal(validarUrl("http://127.0.0.1:9999/", true), true);
});

test("URL malformada não é tratada como portal real (mas também não passa despercebida)", () => {
  // Falhar em parsear não pode virar um bypass silencioso do bloqueio.
  assert.equal(ehPortalReal("nao-e-url"), false);
  assert.equal(ehPortalReal(""), false);
  assert.equal(ehPortalReal(null), false);
});

test("a lista de hosts protegidos cobre os domínios conhecidos", () => {
  assert.ok(HOSTS_PORTAL_REAL.includes("martinbrower.com.br"));
  assert.ok(HOSTS_PORTAL_REAL.includes("martinbrower.com"));
});

test("autorização só vale com a string exata 'true'", () => {
  // Evita que um "1", "yes" ou "TRUE" digitado por engano libere produção.
  for (const valor of ["1", "yes", "sim", "TRUE", "True", ""]) {
    const antes = process.env.MB_ALLOW_REAL_PORTAL;
    process.env.MB_ALLOW_REAL_PORTAL = valor;
    try {
      assert.equal(portalRealAutorizado(), false, `"${valor}" nao deveria autorizar`);
    } finally {
      if (antes === undefined) delete process.env.MB_ALLOW_REAL_PORTAL;
      else process.env.MB_ALLOW_REAL_PORTAL = antes;
    }
  }
});
