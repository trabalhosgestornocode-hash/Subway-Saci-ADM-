import { createApp } from "./app.js";
import { config } from "./config/env.js";

createApp().listen(config.port, () => {
  console.log(`🥪 Subway Saci API rodando em http://localhost:${config.port}`);
  console.log(`   Health:   http://localhost:${config.port}/health`);
  console.log(`   Produtos: http://localhost:${config.port}/api/v1/produtos?vendavel=true`);
});
