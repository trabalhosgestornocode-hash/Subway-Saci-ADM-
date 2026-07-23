import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config/env.js";
import { requireAuth } from "./middlewares/auth.js";
import { notFound } from "./middlewares/notFound.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { router } from "./routes.js";
import { corsOptions, helmetOptions, LIMITES_CORPO, emProducao, cspEmModoBloqueio } from "./config/seguranca.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // O Render fica atrás de proxy: sem isto, req.ip é sempre o do proxy.
  if (emProducao) app.set("trust proxy", 1);

  // CSP montada a partir do que o frontend realmente usa — inclusive o
  // frame-src do portal Martin Brower. Sobe em Report-Only até CSP_ENFORCE=true.
  app.use(helmet(helmetOptions));
  // CORS restrito por allowlist. Sem CORS_ORIGINS = só mesma origem.
  app.use(cors(corsOptions));

  // Limites de corpo POR ROTA. O teto de 30 MB existe apenas onde é
  // necessário (relatórios do SW em base64) em vez de valer para a API toda.
  // A primeira chamada que casar vence — express.json não reprocessa req.body.
  app.use("/api/v1/vendas/importar", express.json({ limit: LIMITES_CORPO.vendasImportacao }));
  app.use("/api/v1/integracoes/martin-brower/import-manual", express.json({ limit: LIMITES_CORPO.martinBrowerImportacao }));
  app.use(express.json({ limit: LIMITES_CORPO.padrao }));

  app.use(morgan(emProducao ? "combined" : "dev", {
    skip: (req) => req.path === "/health",   // não polui o log com o probe
  }));

  // Frontend estático (shell público — a proteção real está na API de dados)
  app.use(express.static(frontendDir));

  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "subway-saci", ts: new Date().toISOString(), csp: cspEmModoBloqueio ? "enforce" : "report-only" })
  );

  // Config pública para o frontend inicializar o Supabase Auth (chave anon é pública por design)
  app.get("/api/config", (_req, res) =>
    res.json({ supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey })
  );

  // 🔒 A PARTIR DAQUI: toda rota de dados exige autenticação real (JWT do Supabase).
  app.use("/api/v1", requireAuth);
  app.get("/api/v1/me", (req, res) => res.json({ data: req.user }));
  app.use("/api/v1", router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
