# STATE

Estado vivo do trabalho e registro de desvios de processo. Atualizado a cada tarefa.

## Estado atual

| Fase | Status |
|---|---|
| 0. Fundação | concluída |
| 1. Requisitos | aprovada (2026-11-05) |
| 2. Plano + ADRs | aprovada (2026-11-05) |
| 3. Tarefas | aprovada (2026-11-05) |
| 4. Implementação | T-01..T-06 concluídas (test:stress da T-05: 5/5 verde); pausa aguardando OK para T-07..T-09 |
| 5. Fechamento | pendente |

Pré-requisito local: Docker Desktop em execução (`docker compose up -d --wait db`).

## Desvios de processo

| Data | Item | Descrição | Ação |
|---|---|---|---|
| 2026-11-05 | Marcação T-01 | O `[x]` da T-01 no `tasks.md` entrou no commit da T-02 (`8b9ce92`), não no da T-01 (`44a7188`): o amend foi recusado pela ferramenta por reescrever histórico sem confirmação. | Regra adotada: marcar `[x]` antes do commit da própria tarefa. Histórico não reescrito. |
| 2026-11-05 | Formato do marcador | A T-04 usa `it.each(...)` para tabelas de validação; o formato fixo do `CLAUDE.md` previa só `it(`/`test(`. | Regra ampliada para aceitar `it.each(`/`test.each(` antes de qualquer script depender dela (o `check:trace` é da T-14). |
| 2026-11-05 | Redact top-level | O teste mínimo de redact revelou que `document`/`email` no nível raiz do objeto de log não eram mascarados (wildcards do pino cobrem só um nível). | Paths de nível raiz adicionados em `src/logger.ts`; coberto por `test/unit/logger.test.ts`. |
| 2026-11-05 | Curinga do redact (**revisão adversarial**) | Paths do pino são exatos por nível: `*.document` não cobre a raiz nem o nível 2. O furo apareceu duas vezes: na raiz (`3e2843a`) e no nível 2 (`a.b.document`, achado agora). | `document`/`email` cobertos em 0, 1 e 2 níveis (`x`, `*.x`, `*.*.x`), com teste por nível. **Risco residual:** nível ≥ 3 continua sem máscara. Mitigações: nunca logar payload/body (regra de código) e o teste Obr-8 (T-13), que faz POST real com marcadores e varre toda a saída de log. |

## Respostas registradas

- **Atomicidade pedido + `CREATED` (T-05):** os dois são gravados numa **única instrução SQL** (CTE `INSERT … ON CONFLICT DO NOTHING RETURNING` + `INSERT INTO order_events … SELECT FROM ins`) em `insertOrderIdempotent`. No Postgres, uma instrução é atômica. Cobertura: `idempotency.test.ts` força a falha do `CREATED` (CHECK temporária) e prova que nenhum pedido fica gravado; `concurrency-post.test.ts` verifica `orphans: 0`.

## Decisões de implementação verificadas

- **Fastify `logController`** (v5.12.8): substitui as opções top-level `disableRequestLogging` e `requestIdLogLabel`, depreciadas (FSTDEP023/FSTDEP024). Fonte: `node_modules/fastify/docs/Reference/Server.md` (seção `logController`) e `docs/Reference/Warnings.md`. O logger continua sendo um pino nosso, passado via `loggerInstance` com `redact`.
- **`.abacusai/`**: configuração local da ferramenta, ignorada no `.gitignore`. Verificado com `git ls-files` e `git log --all --name-only`: nunca foi commitado.
