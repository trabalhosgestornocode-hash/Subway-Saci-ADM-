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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");

export function createApp() {
  const app = express();
  // CSP desligado em dev p/ simplificar; reativar/afinar antes de produção.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());
  app.use(morgan("dev"));

  // Frontend estático (shell público — a proteção real está na API de dados)
  app.use(express.static(frontendDir));

  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "subway-saci", ts: new Date().toISOString() })
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
