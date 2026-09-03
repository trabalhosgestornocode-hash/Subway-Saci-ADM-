# Manifesto — Migration Base / Bootstrap

Arquivo consolidado: [`database/migrations/000_base_migration.sql`](migrations/000_base_migration.sql)

| Campo | Valor |
|---|---|
| Gerado em | 2026-09-03 |
| Branch | `security/fase-p0-hardening` |
| git HEAD de origem | `f12b2f3` |
| Migration final consolidada | `067_agente_quota_atomica.sql` |
| Método | `pg_dump --schema-only --schema=public --no-owner --no-comments` de um banco construído com `schema.sql` + migrations `001..067`, mais seeds **estruturais** (catálogo de módulos, planos, config da plataforma, metas globais, buckets). Sem dados de negócio. |
| Tamanho | 267.408 bytes / 7.867 linhas |
| SHA-256 | `a0f8ad80591572bb7ade423630e2ed6c38135f2e53b3d76293a7588eaaad153f` |

## Contagem de objetos (schema `public`)

Números idênticos entre o Banco A (`schema.sql` + `001..067`) e o Banco B (só `000_base_migration.sql`).

| Objeto | Quantidade |
|---|---|
| Tabelas | 78 |
| Colunas | 991 |
| Views | 4 |
| Views materializadas | 0 |
| Enums | 30 |
| Domínios | 0 |
| Rótulos de enum | 139 |
| Funções do projeto | 23 |
| Funções herdadas da extensão `pgcrypto` | 36 |
| Triggers (não internas) | 37 |
| Índices (excluindo os que respaldam constraints) | 159 |
| Índices (total, incluindo PK/UNIQUE) | 264 |
| Constraints PRIMARY KEY | 78 |
| Constraints FOREIGN KEY | 182 |
| Constraints UNIQUE | 27 |
| Constraints CHECK | 617 |
| Tabelas com RLS habilitada | 77 |
| Tabelas com RLS forçada | 0 |
| Policies RLS | 79 |
| Sequences próprias | 0 |

## Pré-requisitos do ambiente (fornecidos pelo Supabase)

O arquivo **não** recria objetos geridos pelo Supabase. Num PostgreSQL puro, criar antes:

- extensão `pgcrypto` (o arquivo faz `create extension if not exists pgcrypto`);
- schema `auth` + tabela `auth.users` + funções `auth.uid()`, `auth.role()`, `auth.jwt()`;
- schema `storage` + tabela `storage.buckets`;
- roles `anon`, `authenticated`, `service_role`.

## Seeds estruturais incluídos

| Seed | Linhas | Origem |
|---|---|---|
| `modulos` | 16 | migrations 030 / 047 / 059 |
| `planos` | 4 | migration 020 |
| `plataforma_config` | 14 (chaves secretas = `null`) | migration 020 |
| `metas_indicadores` (globais, `organizacao_id`/`unidade_id` = `null`) | 8 | migrations 023 / 024 |
| `storage.buckets` | 3 | migrations 013 / 028 / 037 |

Dados de negócio (empresas, usuários, unidades reais, vendas, financeiro, produtos, iFood, Martin Brower) **não** entram.

## Migrations consolidadas

Base do schema: `database/schema.sql`.

```
001_rls_lockdown                         035_financeiro_diario_opcional
002_produto_historico                    036_financeiro_snapshot_acumulado
003_papeis_usuario                       037_parser_food_delivery
004_custo_manual                         038_parser_fd_operacao
005_saladas_e_faltantes                  039_parser_fd_sem_entregador
007_reverter_frango_defumado             040_parser_fd_remove_unique_pedido
008_ifood_tabelas_extra                  041_bonificacao_mensal_unidade_teste
009_ifood_adicionais_bebidas             042_bonificacao_indicadores_manuais
010_balcao_dobro_todas_tabelas           043_bonificacao_indicadores_manuais_reverter
011_remover_bebidas_s2c                  044_bonificacao_pesquisas_faixa3_correcao
012_vendas_sw                            045_bonificacao_cupons_geral
013_vendas_completa                      046_parser_fd_classificacao_cancelamentos
014_rls_isolamento                       047_agente_crescer_modulo
015_multi_membership_papeis              048_agente_conversas
016_rls_por_vinculos                     049_agente_uso
017_martin_brower                        050_agente_mensagens_acoes
018_mb_filtros_unicidade                 051_unidade_tabela_comercial_historico
019_client_id_text_e_idempotencia        052_super_restaurante_rev_mensal
020_saas_superadmin                      053_estrutura_organizacional
021_insumos_ficha_cmv                    054_fix_schema_qualificado_helper_estrutura
022_origem_reconstrucao                  055_excluir_organizacao_definitivamente
023_dashboard_executivo                  056_ifood_integracao
024_modelo_logistico_ifood               057_unidade_dados_contato
025_unidades_teste_e_reset               058_unidade_config
026_desempenho_opcional_e_lancamento_mensal  059_inteligencia_modulo_secao
027_exclusao_lancamento_e_mensal_completo    060_perfis_operacionais
028_bonificacao_mensal                   061_painel_administrativo
029_novas_unidades_rio_poty_ideal_mall   062_sessoes_contexto_perfil_check
030_modulos_por_empresa                  063_vinculos_perfil_id_not_null
031_ppd_bonificacao_decimal              064_pin_selecao_perfil
032_bonificacao_lancamentos_exclusoes    065_dashboard_executivo_situacao_parcial
033_lancamento_mensal_gerenciamento      066_ajustes_favor_contra_loja
034_unidades_gerenciamento               067_agente_quota_atomica
```

`006` não existe no repositório. `019_VERIFICACAO_antes_e_depois.sql` é script **somente leitura** de verificação — não faz parte do schema e não foi consolidado.

## Regras de uso

- **NÃO** aplicar em produção nem registrar como migration aplicada em produção. Produção segue com as incrementais `001..067`.
- **NÃO** reexecutar sobre banco com dados — o arquivo roda **uma vez** em banco vazio.
- Este arquivo **não substitui** as migrations históricas; elas continuam sendo a fonte de verdade do histórico.
