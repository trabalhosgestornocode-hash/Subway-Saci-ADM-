// Servidor do worker.
//
// Nunca é exposto publicamente: o Cloud Run sobe com
// --no-allow-unauthenticated, e o HMAC é a segunda camada. Não há CORS, não há
// arquivo estático, não há rota pública além do /health.

import express from "express";
import { config, validarConfig } from "./config.js";
import { exigirHmac } from "./auth.middleware.js";
import { rotas, health } from "./routes.js";
import * as sessions from "./sessions.js";
import { log, memoriaMb } from "./logsafe.js";

// Falhar no boot é melhor que subir sem autenticação.
validarConfig();

const app = express();
app.disable("x-powered-by");

// Probe do Cloud Run — antes do HMAC, de propósito. Não revela nada sensível.
app.get("/health", health);

// express.raw: o HMAC assina os BYTES recebidos. Reparsear e reserializar
// JSON mudaria a representação (ordem de chaves, espaços) e quebraria a
// assinatura. As rotas usam `req.corpoJson`, produzido pelo middleware.
app.use(
  "/internal/martin-brower",
  express.raw({ type: "*/*", limit: config.limiteCorpoBytes }),
  exigirHmac(config.segredoHmac),
  rotas,
);

// Nenhuma outra rota existe. Resposta genérica: não damos mapa do serviço.
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// Rede final: nada além do código de erro chega ao chamador.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log("error", "erro_nao_tratado", { rota: req.path, mensagem: err?.message });
  res.status(500).json({ error: "MARTIN_BROWER_UNAVAILABLE" });
});

const servidor = app.listen(config.porta, () => {
  log("info", "worker.iniciado", {
    porta: config.porta,
    ttlSessaoMs: sessions.TTL_TOTAL_MS,
    maxSessoes: sessions.MAX_SESSOES,
    ...memoriaMb(),
  });
});

servidor.headersTimeout = 65_000;
servidor.requestTimeout = config.timeoutExecucaoMs;

// --- shutdown gracioso ----------------------------------------------------
// O Cloud Run manda SIGTERM e dá ~10 s antes de matar o container. Sem isto,
// um Chromium ficaria órfão e a sessão morreria sem limpar as credenciais.
let encerrando = false;
async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  log("warn", "worker.encerrando", { sinal, sessoesAtivas: sessions.sessoesAtivas() });

  // Para de aceitar conexões novas primeiro.
  servidor.close();
  // Depois destrói browsers e apaga segredos.
  await sessions.encerrarTodas(sinal);

  log("info", "worker.encerrado", { sinal });
  process.exit(0);
}

for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, () => encerrar(sinal));

// Exceção não capturada com Chromium aberto vazaria o processo do browser.
process.on("uncaughtException", async (e) => {
  log("error", "excecao_nao_capturada", { mensagem: e.message });
  await sessions.encerrarTodas("uncaughtException");
  process.exit(1);
});
process.on("unhandledRejection", (motivo) => {
  log("error", "promessa_rejeitada", { mensagem: String(motivo?.message ?? motivo) });
});
