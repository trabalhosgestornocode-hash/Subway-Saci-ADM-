// Ciclo de vida do Chromium.
//
// Um browser por sessão, destruído no fim. Não há pool: com concurrency=1 no
// Cloud Run, reaproveitar browser entre sessões só arriscaria vazar cookies de
// uma sincronização para a seguinte.

import { chromium } from "playwright";
import { log, cronometro } from "./logsafe.js";

// Flags mínimas para container. Nenhuma delas enfraquece segurança do site:
//   --no-sandbox            o sandbox do Chromium exige privilégios que o
//                           Cloud Run não concede; o isolamento aqui é o
//                           próprio container.
//   --disable-dev-shm-usage /dev/shm padrão do container é pequeno (64 MB) e
//                           o Chromium estoura ao renderizar páginas grandes.
const ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--no-first-run",
];

export async function abrirNavegador(sessao) {
  const t = cronometro("browser.aberto", { remoteSessionId: sessao.remoteSessionId });

  const browser = await chromium.launch({ headless: true, args: ARGS });
  // Contexto isolado: cookies e storage morrem com ele. `storageState` NUNCA
  // é salvo em disco — é assim que garantimos que nenhum cookie do portal
  // sobrevive à sessão.
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    ignoreHTTPSErrors: false,
  });
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(45_000);

  const page = await context.newPage();

  // Corta o que não precisamos: menos memória e páginas mais rápidas. Não
  // bloqueamos CSS nem fontes — o portal pode depender deles para renderizar
  // os campos que vamos procurar.
  await page.route("**/*", (rota) => {
    const tipo = rota.request().resourceType();
    if (tipo === "image" || tipo === "media") return rota.abort();
    return rota.continue();
  });

  // Erros de página vão para o log do worker — nunca para o backend.
  page.on("pageerror", (e) => log("warn", "pagina.erro_js", { mensagem: e.message }));

  sessao.browser = browser;
  sessao.browserContext = context;
  sessao.page = page;

  t.fim();
  return page;
}
