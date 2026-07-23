// Seletores do Portal Martin Brower — TODOS num arquivo só.
//
// POR QUE ISOLADO: o portal é de terceiro e pode mudar sem aviso. Quando
// quebrar, o conserto é aqui, e só aqui. Nenhum outro arquivo do worker
// contém seletor.
//
// ESTRATÉGIA — do mais estável para o mais frágil:
//   1. papel + nome acessível (getByRole)  — sobrevive a mudança de CSS e de
//      estrutura do DOM; quebra só se o texto visível mudar;
//   2. label / placeholder                 — idem, ancorado no que o usuário lê;
//   3. atributos semânticos (type, name)   — estáveis, mas genéricos demais
//      para usar sozinhos;
//   4. CSS/id                              — último recurso, o mais frágil.
//
// NUNCA dependemos de UM seletor único: cada elemento tem uma LISTA de
// candidatos, tentados em ordem. `primeiroVisivel()` devolve o primeiro que
// realmente aparecer, e registra QUAL funcionou — assim o log mostra quando o
// portal mudou e passamos a cair no fallback, antes de quebrar de vez.
//
// ⚠️ NÃO VALIDADO CONTRA O PORTAL REAL. Estes candidatos vêm dos padrões do
// framework do portal (Angular/PrimeFaces) e das convenções comuns de tela de
// login em pt-BR. A primeira execução real contra a Martin Brower vai dizer
// quais acertaram — e o log de `seletor.usado` mostra exatamente isso.

import { log } from "./logsafe.js";

export const SELETORES = {
  // --- login ------------------------------------------------------------
  campoUsuario: [
    { tipo: "label", valor: /usu[áa]rio|login|e-?mail|c[óo]digo/i },
    { tipo: "placeholder", valor: /usu[áa]rio|login|e-?mail/i },
    { tipo: "css", valor: 'input[name*="user" i], input[id*="user" i], input[name*="login" i]' },
    { tipo: "css", valor: 'form input[type="text"]:not([type="hidden"])' },
  ],
  campoSenha: [
    { tipo: "label", valor: /senha|password/i },
    { tipo: "css", valor: 'input[type="password"]' },
  ],
  botaoEntrar: [
    { tipo: "role", papel: "button", nome: /entrar|acessar|login|sign in/i },
    { tipo: "css", valor: 'button[type="submit"], input[type="submit"]' },
  ],

  // --- segundo fator ----------------------------------------------------
  campoCodigo2fa: [
    { tipo: "label", valor: /c[óo]digo|token|verifica|seguran[çc]a/i },
    { tipo: "placeholder", valor: /c[óo]digo|token/i },
    { tipo: "css", valor: 'input[name*="cod" i], input[name*="token" i], input[autocomplete="one-time-code"]' },
  ],
  botaoConfirmarCodigo: [
    { tipo: "role", papel: "button", nome: /confirmar|validar|verificar|enviar|continuar/i },
    { tipo: "css", valor: 'button[type="submit"]' },
  ],

  // --- detecção de estado (não são campos, são SINAIS) -------------------
  sinalDois2fa: [
    { tipo: "texto", valor: /c[óo]digo de (seguran[çc]a|verifica[çc][ãa]o)|enviamos um c[óo]digo|token de acesso/i },
  ],
  sinalCredencialInvalida: [
    { tipo: "texto", valor: /usu[áa]rio ou senha inv[áa]lid|credenciais inv[áa]lid|senha incorreta|dados incorretos/i },
  ],
  sinalBloqueio: [
    { tipo: "texto", valor: /bloquead|conta suspensa|excedeu.*tentativas|temporariamente indispon/i },
  ],
  // CAPTCHA: detectar para PARAR, jamais para contornar.
  sinalCaptcha: [
    { tipo: "css", valor: 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey]' },
    { tipo: "texto", valor: /n[ãa]o sou um rob[ôo]|verifica[çc][ãa]o de seguran[çc]a|captcha/i },
  ],
  // Presença simultânea destes = autenticado.
  sinalAutenticado: [
    { tipo: "role", papel: "link", nome: /sair|logout|encerrar sess[ãa]o/i },
    { tipo: "texto", valor: /meus pedidos|novo pedido|bem-?vindo/i },
  ],
};

/** Constrói um Locator do Playwright a partir de um candidato. */
function localizar(page, candidato) {
  switch (candidato.tipo) {
    case "role":        return page.getByRole(candidato.papel, { name: candidato.nome });
    case "label":       return page.getByLabel(candidato.valor);
    case "placeholder": return page.getByPlaceholder(candidato.valor);
    case "texto":       return page.getByText(candidato.valor);
    case "css":         return page.locator(candidato.valor);
    default:            return null;
  }
}

const descrever = (c) =>
  c.tipo === "role" ? `role:${c.papel}(${c.nome})` : `${c.tipo}:${c.valor ?? c.nome}`;

/**
 * Tenta cada candidato em ordem e devolve o primeiro VISÍVEL.
 * Registra qual funcionou — se o log mostrar que estamos caindo no último
 * candidato, o portal mudou e os seletores precisam ser revistos ANTES de
 * quebrarem de vez.
 *
 * @returns {Promise<import('playwright').Locator|null>}
 */
export async function primeiroVisivel(page, nomeDoAlvo, { timeout = 5000 } = {}) {
  const candidatos = SELETORES[nomeDoAlvo];
  if (!candidatos) throw new Error(`seletor desconhecido: ${nomeDoAlvo}`);

  for (let i = 0; i < candidatos.length; i += 1) {
    const c = candidatos[i];
    const loc = localizar(page, c);
    if (!loc) continue;
    try {
      // .first() porque um candidato genérico pode casar com vários elementos.
      const alvo = loc.first();
      await alvo.waitFor({ state: "visible", timeout: i === 0 ? timeout : 1500 });
      if (i > 0) {
        log("warn", "seletor.fallback", {
          alvo: nomeDoAlvo, posicao: i, usado: descrever(c),
          nota: "o candidato preferido falhou — o portal pode ter mudado",
        });
      }
      return alvo;
    } catch { /* tenta o próximo candidato */ }
  }

  log("warn", "seletor.nao_encontrado", { alvo: nomeDoAlvo, candidatos: candidatos.length });
  return null;
}

/** Existe algum sinal deste tipo na página? Usado para detectar estado. */
export async function existeSinal(page, nomeDoSinal, { timeout = 2000 } = {}) {
  const candidatos = SELETORES[nomeDoSinal] ?? [];
  for (const c of candidatos) {
    const loc = localizar(page, c);
    if (!loc) continue;
    try {
      await loc.first().waitFor({ state: "visible", timeout });
      log("info", "sinal.detectado", { sinal: nomeDoSinal, via: descrever(c) });
      return true;
    } catch { /* próximo */ }
  }
  return false;
}
