import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { TIMEOUTS } from "./config/seguranca.js";
import { inicializarWorkerRemoto } from "./modules/martinbrower/martinbrower.worker.contract.js";

// Worker Martin Brower: só é carregado com MB_PLAYWRIGHT_ENABLED=true. Com a
// flag desligada (padrão), o adapter nem é importado — nenhum código de
// integração remota entra neste processo, e as rotas respondem WORKER_DISABLED.
// Nunca derruba a subida: sem worker, o estado seguro é "desabilitado".
inicializarWorkerRemoto().then((r) => {
  console.log(r.habilitado
    ? `   Martin Brower: worker remoto ATIVO (${r.url})`
    : `   Martin Brower: worker DESABILITADO (${r.motivo})`);
});

const servidor = createApp().listen(config.port, () => {
  console.log(`🥪 Subway Saci API rodando em http://localhost:${config.port}`);
  console.log(`   Health:   http://localhost:${config.port}/health`);
  console.log(`   Produtos: http://localhost:${config.port}/api/v1/produtos?vendavel=true`);
});

// Timeouts globais: sem eles uma conexão lenta (ou maliciosa) segura um socket
// indefinidamente. keepAliveTimeout > o do proxy do Render evita 502 espúrio.
servidor.requestTimeout = TIMEOUTS.requestTimeoutMs;
servidor.headersTimeout = TIMEOUTS.headersTimeoutMs;
servidor.keepAliveTimeout = TIMEOUTS.keepAliveTimeoutMs;

// Encerramento gracioso: o Render manda SIGTERM antes de derrubar a instância.
for (const sinal of ["SIGTERM", "SIGINT"]) {
  process.on(sinal, () => {
    console.log(`[${sinal}] encerrando servidor…`);
    servidor.close(() => process.exit(0));
    // Rede de segurança caso alguma conexão não feche sozinha.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
