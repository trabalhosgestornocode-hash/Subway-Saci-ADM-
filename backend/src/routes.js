import { Router } from "express";
import { requireContexto, exigirSenhaDefinitiva } from "./middlewares/auth.js";
import { produtosRouter } from "./modules/produtos/produtos.routes.js";
import { insumosRouter } from "./modules/insumos/insumos.routes.js";
import { cmvRouter } from "./modules/cmv/cmv.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { dashboardExecutivoRouter } from "./modules/dashboard-executivo/dashboardExecutivo.routes.js";
import { bonificacaoMensalRouter } from "./modules/bonificacao-mensal/bonificacaoMensal.routes.js";
import { usuariosRouter } from "./modules/usuarios/usuarios.routes.js";
import { vendasRouter } from "./modules/vendas/vendas.routes.js";
import { contextoRouter } from "./modules/contexto/contexto.routes.js";
import { sessaoRouter } from "./modules/sessao/sessao.routes.js";
import { plataformaRouter } from "./modules/plataforma/plataforma.routes.js";
import { martinBrowerRouter } from "./modules/martinbrower/martinbrower.routes.js";

// Todas as rotas daqui já passaram por `requireAuth` (aplicado em app.js).
// O que este arquivo decide é a SEGUNDA camada, e ela divide a API em três
// mundos que não se encostam:
//
//   1. SESSÃO      — sem contexto. É onde o contexto é criado.
//   2. PLATAFORMA  — SuperAdmin. Nunca tem `req.tenant`.
//   3. TENANT      — exige Context Token. Todo dado é escopado por ele.
//
// O `requireContexto` fica aqui, aplicado por router, e não dentro de cada
// módulo: assim o isolamento é visível em um único lugar e um módulo novo não
// entra na API sem passar por essa decisão explícita.

export const router = Router();

// --- 1. Sessão: escolher empresa, trocar unidade, sair, TROCAR A SENHA.
//     Montado ANTES do gate de senha provisória de propósito: é aqui que mora
//     a rota que TIRA o usuário desse estado (/sessao/senha) e a de logout.
//     As demais rotas de sessão se auto-bloqueiam internamente.
router.use("/sessao", sessaoRouter);

// --- Gate de senha provisória: daqui para baixo, nada funciona enquanto o
//     usuário não tiver definido uma senha própria. Cobre plataforma, tenant
//     e contexto de uma vez — inclusive o SuperAdmin precisa trocar a senha
//     provisória antes de administrar o que quer que seja.
router.use(exigirSenhaDefinitiva);

// --- 2. Painel SuperAdmin (o próprio router exige superadmin).
router.use("/plataforma", plataformaRouter);

// --- 3. Rotas de tenant: a partir daqui, nada responde sem Context Token.
const tenant = Router();
tenant.use(requireContexto);
tenant.use("/produtos", produtosRouter);
tenant.use("/insumos", insumosRouter);
tenant.use("/cmv", cmvRouter);
tenant.use("/dashboard", dashboardRouter);
tenant.use("/dashboard-executivo", dashboardExecutivoRouter);
tenant.use("/bonificacao-mensal", bonificacaoMensalRouter);
tenant.use("/usuarios", usuariosRouter);
tenant.use("/vendas", vendasRouter);
tenant.use("/integracoes/martin-brower", martinBrowerRouter);
router.use(tenant);

// `contexto` é legado: existia para o seletor de organização antes do Context
// Token, e o front novo usa /sessao. Fica no ar porque a rota de auditoria de
// acessos do superadmin (GET /contexto/acessos) ainda é útil e já é usada.
// Não exige contexto — é sobre o usuário, não sobre uma empresa.
router.use("/contexto", contextoRouter);
