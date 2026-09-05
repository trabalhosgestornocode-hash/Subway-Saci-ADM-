import { Router } from 'express';
import { requireSuperadmin, exigirMfaSeExigido } from '../../middlewares/auth.js';
import * as c from './desenvolvimento.controller.js';
// Montado DENTRO do administrativoRouter, depois de autenticação, acesso ao
// painel e MFA. Quem chega aqui já passou por `requirePainelAdministrativo`.
//
// Leitura e ESCRITA são de qualquer usuário autorizado do Painel
// Administrativo: criar, editar, mover status/prioridade/progresso/previsão,
// trocar responsável, concluir, reabrir, arquivar e comentar em público.
// O service revalida tudo — este router não é a única barreira.
export const desenvolvimentoRouter = Router();
desenvolvimentoRouter.get('/catalogos',c.catalogos);
desenvolvimentoRouter.get('/resumo',c.resumo);
desenvolvimentoRouter.get('/atualizacoes',c.atualizacoes);
desenvolvimentoRouter.get('/demandas',c.listar);
desenvolvimentoRouter.get('/demandas/:id',c.obter);
desenvolvimentoRouter.post('/demandas',c.criar);
desenvolvimentoRouter.patch('/demandas/:id',c.editar);
desenvolvimentoRouter.post('/demandas/:id/atualizacoes',c.adicionar);
// Só a EXCLUSÃO DEFINITIVA é do SuperAdmin. Arquivar continua com todos.
desenvolvimentoRouter.delete('/demandas/:id',requireSuperadmin,exigirMfaSeExigido('superadmin'),c.excluir);
