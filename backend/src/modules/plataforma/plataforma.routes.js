import { Router } from "express";
import * as c from "./plataforma.controller.js";
import { requireSuperadmin } from "../../middlewares/auth.js";

// API do Painel SuperAdmin.
//
// O `requireSuperadmin` está aplicado ao ROUTER INTEIRO, não rota por rota.
// Essa escolha é deliberada: uma rota nova adicionada aqui já nasce protegida.
// O padrão contrário — decorar cada rota — só precisa de um esquecimento para
// abrir o painel da plataforma para um usuário de tenant.
//
// Nenhuma rota daqui passa por `requireContexto`: o SuperAdmin não tem empresa,
// e é isso que garante que o painel nunca opere sob o contexto de um cliente.
// A única ponte entre os dois mundos é POST /empresas/:id/entrar, que EMITE um
// Context Token de impersonação e registra a auditoria.

export const plataformaRouter = Router();
plataformaRouter.use(requireSuperadmin);

// ---- Dashboard Global
plataformaRouter.get("/dashboard", c.obterDashboard);
plataformaRouter.get("/sessoes", c.sessoesVivas);

// ---- Empresas
plataformaRouter.get("/empresas", c.listarEmpresas);
plataformaRouter.post("/empresas", c.criarEmpresa);
plataformaRouter.get("/empresas/:id", c.obterEmpresa);
plataformaRouter.patch("/empresas/:id", c.atualizarEmpresa);
plataformaRouter.delete("/empresas/:id", c.excluirEmpresa);
plataformaRouter.patch("/empresas/:id/status", c.alterarStatusEmpresa);
plataformaRouter.patch("/empresas/:id/plano", c.alterarPlanoEmpresa);
plataformaRouter.get("/empresas/:id/usuarios", c.usuariosDaEmpresa);
plataformaRouter.get("/empresas/:id/unidades", c.unidadesDaEmpresa);
plataformaRouter.get("/empresas/:id/logs", c.logsDaEmpresa);
plataformaRouter.post("/empresas/:id/entrar", c.entrarComoEmpresa);

// ---- Módulos (catálogo geral + por empresa)
plataformaRouter.get("/modulos", c.catalogoModulos);   // antes de /empresas/:id/modulos, sem colisão (prefixo diferente)
plataformaRouter.get("/empresas/:id/modulos", c.modulosDaEmpresa);
plataformaRouter.put("/empresas/:id/modulos", c.definirModulosEmpresa);

// ---- Usuários globais
plataformaRouter.get("/usuarios", c.listarUsuarios);
plataformaRouter.post("/usuarios", c.criarUsuario);
plataformaRouter.get("/usuarios/papeis", c.papeis);   // antes de /:id, senão "papeis" cai como id
plataformaRouter.get("/usuarios/:id", c.obterUsuario);
plataformaRouter.patch("/usuarios/:id", c.atualizarUsuario);
plataformaRouter.delete("/usuarios/:id", c.excluirUsuario);
plataformaRouter.post("/usuarios/:id/senha", c.redefinirSenha);
plataformaRouter.post("/usuarios/:id/email", c.alterarEmail);
plataformaRouter.post("/usuarios/:id/logout", c.forcarLogout);
plataformaRouter.post("/usuarios/:id/superadmin", c.definirSuperadmin);

// ---- Associação de usuários a empresas/unidades
plataformaRouter.post("/usuarios/:id/empresas", c.associarEmpresa);
plataformaRouter.patch("/usuarios/:id/empresas/:organizacaoId", c.atualizarVinculo);
plataformaRouter.delete("/usuarios/:id/empresas/:organizacaoId", c.removerVinculo);
plataformaRouter.post("/usuarios/:id/unidades", c.associarUnidade);
plataformaRouter.delete("/usuarios/:id/unidades/:unidadeId", c.removerVinculoUnidade);

// ---- Financeiro do SaaS
plataformaRouter.get("/financeiro", c.panoramaFinanceiro);
plataformaRouter.get("/financeiro/metricas", c.metricas);
plataformaRouter.get("/financeiro/planos", c.listarPlanos);
plataformaRouter.post("/financeiro/planos", c.criarPlano);
plataformaRouter.patch("/financeiro/planos/:id", c.atualizarPlano);
plataformaRouter.get("/financeiro/assinaturas", c.listarAssinaturas);
plataformaRouter.post("/financeiro/assinaturas", c.criarAssinatura);
plataformaRouter.patch("/financeiro/assinaturas/:id", c.atualizarAssinatura);
plataformaRouter.get("/financeiro/cobrancas", c.listarCobrancas);
plataformaRouter.post("/financeiro/cobrancas", c.criarCobranca);
plataformaRouter.patch("/financeiro/cobrancas/:id", c.atualizarCobranca);

// ---- Monitoramento
plataformaRouter.get("/monitoramento", c.obterMonitoramento);

// ---- Logs e Auditoria (somente leitura — a tabela é append-only no banco)
plataformaRouter.get("/auditoria", c.listarAuditoria);
plataformaRouter.get("/auditoria/filtros", c.filtrosAuditoria);
plataformaRouter.get("/auditoria/impersonacoes", c.impersonacoes);

// ---- Configurações globais
plataformaRouter.get("/configuracoes", c.listarConfiguracoes);
plataformaRouter.put("/configuracoes", c.salvarConfiguracoes);

// ---- Atualizações e IA
plataformaRouter.get("/atualizacoes", c.atualizacoes);
plataformaRouter.get("/ia", c.ia);

// Qualquer outra coisa sob /plataforma é 404 em JSON.
plataformaRouter.use(c.naoEncontrado);
