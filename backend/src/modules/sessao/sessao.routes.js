import { Router } from "express";
import * as controller from "./sessao.controller.js";
import { requireContexto, exigirSenhaDefinitiva } from "../../middlewares/auth.js";

// Rotas de sessão. Todas exigem estar AUTENTICADO (requireAuth já roda em
// /api/v1), mas quase nenhuma exige CONTEXTO — é justamente aqui que o
// contexto nasce. Aplicar requireContexto ao router inteiro criaria um
// impasse: não daria para escolher a empresa sem já ter escolhido uma.
export const sessaoRouter = Router();

// Trocar a própria senha. É a ÚNICA saída do estado "senha provisória", então
// NÃO passa pelo gate `exigirSenhaDefinitiva` — se passasse, o usuário ficaria
// preso: bloqueado para tudo, inclusive para se desbloquear.
sessaoRouter.post("/senha", controller.novaSenha);

// As rotas abaixo exigem senha definitiva: escolher empresa/unidade antes de
// definir a senha própria não faz sentido e é bloqueado. (O gate global de
// routes.js só cobre o que vem DEPOIS do mount de /sessao; por isso as rotas
// de sessão que devem ser bloqueadas repetem o gate aqui.)
sessaoRouter.get("/acessos", exigirSenhaDefinitiva, controller.acessos);
sessaoRouter.post("/selecionar", exigirSenhaDefinitiva, controller.selecionar);

// `atual` exige contexto (é o que ele descreve).
sessaoRouter.get("/atual", exigirSenhaDefinitiva, requireContexto, controller.atual);

// `encerrar` funciona com ou sem contexto: revoga o que houver. Se exigisse
// contexto, um token já expirado impediria o logout — o pior momento para
// travar o usuário.
sessaoRouter.post("/encerrar", contextoOpcional, controller.encerrar);

/** Tenta resolver o contexto; segue em frente se não houver. */
function contextoOpcional(req, res, next) {
  if (!req.header("x-context-token")) return next();
  requireContexto(req, res, (erro) => next(erro && erro.statusCode === 409 ? undefined : erro));
}
