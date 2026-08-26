// Alterações estruturais de alto risco: promover unidade -> empresa,
// converter empresa -> unidade, transferir unidade entre empresas.
//
// TODA a lógica (validação de integridade, clonagem de catálogo quando
// necessário, remapeamento de referências, revogação de sessões e o
// próprio registro de auditoria) roda DENTRO de uma função PL/pgSQL — ver
// database/migrations/053_estrutura_organizacional.sql. É a única forma de
// ter transação real com rollback completo neste projeto: o cliente
// supabase-js faz uma requisição HTTP por `.from(...)`, sem transação entre
// chamadas; uma função de banco chamada via `.rpc()` roda inteira numa
// única transação do lado do Postgres — se qualquer passo falhar, tudo
// volta atrás sozinho, sem o backend precisar orquestrar rollback manual.
//
// Por isso este arquivo é fino: valida o formato da entrada (a função SQL
// valida a EXISTÊNCIA/integridade de novo, porque nunca confia só no
// backend) e traduz o erro do Postgres pro formato ApiError do resto da API.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";

/** @param {import('express').Request} req */
function origemDe(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}

/**
 * As funções SQL usam RAISE EXCEPTION para os dois casos que importam pro
 * usuário: "não encontrado" (P0002) e "regra de negócio violada" (22023).
 * Os dois viram 400/404 com a mensagem exata que a função escreveu — o
 * texto já é pt-BR e explicativo (ver a migration). Qualquer outro erro
 * (falha de conexão, coluna que não existe etc.) é um bug real: vira 500.
 * @param {{message?: string, code?: string}} error
 */
function traduzirErroRpc(error) {
  if (error.code === "P0002") return ApiError.notFound(error.message);
  if (error.code === "22023") return ApiError.badRequest(error.message);
  return ApiError.internal(error.message || "Falha ao executar a operação estrutural.");
}

/**
 * Promove uma unidade a empresa independente. A unidade preserva ID e todo
 * o histórico operacional (nada nessas tabelas é tocado — só o
 * organizacao_id da própria unidade muda); só o catálogo, que hoje é
 * exclusivo da empresa-mãe, é clonado para a empresa nova.
 * @param {import('express').Request} req
 * @param {string} unidadeIdBruto
 * @param {{nomeEmpresa?: unknown}} body
 */
export async function promoverUnidade(req, unidadeIdBruto, body) {
  const unidadeId = v.uuid(unidadeIdBruto, "Unidade");
  const nomeEmpresa = v.textoOpcional(body?.nomeEmpresa, "Nome da empresa", { max: 160 });
  const { ip, userAgent } = origemDe(req);

  const { data, error } = await supabase.rpc("promover_unidade_para_empresa", {
    p_unidade_id: unidadeId,
    p_nome_empresa: nomeEmpresa,
    p_ator_id: req.user.id,
    p_ator_email: req.user.email,
    p_ip: ip,
    p_user_agent: userAgent,
  });
  if (error) throw traduzirErroRpc(error);
  return data;
}

/**
 * Transfere uma unidade de uma empresa para outra. Preserva integralmente
 * os dados da unidade — só o organizacao_id muda. Catálogo e integrações
 * (SW/Martin Brower) NÃO são remapeados automaticamente (ver comentário na
 * migration): a unidade passa a usar o catálogo da empresa nova a partir
 * de agora; o histórico continua legível porque nada é apagado da empresa
 * anterior.
 * @param {import('express').Request} req
 * @param {string} unidadeIdBruto
 * @param {{novaOrganizacaoId?: unknown}} body
 */
export async function transferirUnidade(req, unidadeIdBruto, body) {
  const unidadeId = v.uuid(unidadeIdBruto, "Unidade");
  const novaOrganizacaoId = v.uuid(body?.novaOrganizacaoId, "Empresa de destino");
  const { ip, userAgent } = origemDe(req);

  const { data, error } = await supabase.rpc("transferir_unidade_organizacao", {
    p_unidade_id: unidadeId,
    p_nova_organizacao_id: novaOrganizacaoId,
    p_ator_id: req.user.id,
    p_ator_email: req.user.email,
    p_ip: ip,
    p_user_agent: userAgent,
  });
  if (error) throw traduzirErroRpc(error);
  return data;
}

/**
 * Converte uma empresa (sem unidades próprias) numa unidade dentro de outra
 * empresa. Só permitido quando a empresa não tem nenhuma unidade
 * cadastrada — ver o motivo no comentário da migration. A empresa
 * convertida não é excluída: fica arquivada (status "cancelada"), com o
 * catálogo próprio (se houver) preservado mas não mesclado ao da
 * empresa-mãe.
 * @param {import('express').Request} req
 * @param {string} organizacaoIdBruto
 * @param {{empresaMaeId?: unknown}} body
 */
export async function converterEmpresaParaUnidade(req, organizacaoIdBruto, body) {
  const organizacaoId = v.uuid(organizacaoIdBruto, "Empresa");
  const empresaMaeId = v.uuid(body?.empresaMaeId, "Empresa-mãe");
  const { ip, userAgent } = origemDe(req);

  const { data, error } = await supabase.rpc("converter_empresa_para_unidade", {
    p_organizacao_id: organizacaoId,
    p_empresa_mae_id: empresaMaeId,
    p_ator_id: req.user.id,
    p_ator_email: req.user.email,
    p_ip: ip,
    p_user_agent: userAgent,
  });
  if (error) throw traduzirErroRpc(error);
  return data;
}
