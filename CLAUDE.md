# CLAUDE.md

Instruções para agentes e pessoas que trabalham neste repositório.

## Visão do projeto

Case técnico (Grupo Morada, Dev Sênior): uma API pequena que recebe pedidos de venda e os encaminha a um ERP externo simulado. O ERP pode falhar, ficar lento, dar timeout ou processar o pedido sem que a resposta chegue.

Requisito central: **minimizar pedidos duplicados e manter rastreabilidade** de cada solicitação.

Escopo deliberadamente pequeno (2 a 4 horas). Simplicidade bem justificada vale mais que sofisticação. Enunciado: `docs/desafio.pdf`.

Documentos de referência:
- `docs/specs/requirements.md`: requisitos EARS com IDs (fonte de verdade do comportamento).
- `docs/specs/plan.md`: plano técnico (modelo de dados, máquina de estados, algoritmos).
- `docs/specs/tasks.md`: tarefas ordenadas (T-01...).
- `docs/specs/traceability.md`: matriz REQ-ID -> teste, **gerada** por `npm run check:trace -- --write` (não editar à mão).
- `docs/adr/`: decisões de arquitetura.
- `STATE.md`: estado atual das fases e registro de desvios de processo.

## Stack

- Node.js (LTS) + TypeScript em modo `strict`
- Fastify (HTTP), Zod (validação)
- PostgreSQL via driver `pg`, migrations em SQL puro
- pino (logs estruturados, com `redact`)
- Vitest (testes unitários e de integração contra Postgres real)
- Docker Compose para o Postgres local e de testes

Fora do escopo por decisão: Redis, filas externas, circuit breaker, ORM. O Postgres é a fonte de verdade e a fila.

## Comandos

Os scripts são criados na tarefa T-01; até lá, esta é a interface planejada.

```bash
npm install                 # instala dependências
docker compose up -d db     # sobe o Postgres local
cp .env.example .env        # configura variáveis (sem segredos reais)
npm run migrate             # aplica migrations SQL
npm run dev                 # API + worker em modo desenvolvimento
npm test                    # todos os testes (exige Postgres de pé)
npm run lint                # ESLint
npm run typecheck           # tsc --noEmit
npm run test:stress         # testes de concorrência 5x seguidas (fechamento de T-05 e T-14)
npm run check:trace         # valida requisito -> teste e a matriz em docs/specs/traceability.md
```

## Convenções de código

- Código, identificadores, nomes de arquivos e commits em inglês. Documentação e conversa em português.
- Estrutura: `src/http/`, `src/domain/`, `src/infra/db/`, `src/infra/erp/`, `src/worker/`.
- Funções pequenas e explícitas. Nada de abstrações genéricas, repositórios genéricos ou camadas sem justificativa.
- SQL parametrizado sempre; nunca concatenar entrada do usuário.
- Toda mudança de status passa pela máquina de estados do domínio e por um `UPDATE ... WHERE status = <esperado>` (transição guardada).
- Erros do ERP são guardados como código + mensagem curta. Nunca guardar ou logar body bruto.
- Nunca logar payload completo nem dados pessoais. Todo log de operação carrega `correlationId`, `orderId`, `attempt` e `status` quando aplicável.
- Configuração somente por variáveis de ambiente, validadas com Zod na inicialização. `.env.example` sem valores sensíveis.
- Commits no padrão Conventional Commits, citando tarefa e REQ-IDs:
  `feat(idempotency): T-04 unique key + request hash [REQ-IDEM-01..03]`

## Regra de ouro: spec primeiro, depois teste, depois código

1. Nenhum código de produção sem requisito correspondente em `docs/specs/requirements.md`.
2. Se o comportamento precisa mudar, atualize a spec **antes** do código e registre o motivo.
3. Para cada tarefa: escreva o teste, veja-o falhar, implemente o mínimo, rode testes + typecheck + lint, faça commit.
4. Nada de funcionalidade fora da spec. Ideias novas vão para "Perguntas em aberto" na spec.

## Regras de testes

- Cada teste referencia os IDs de requisito que cobre, em comentário logo acima do `it`/`test`:
  ```ts
  // REQ-IDEM-02
  it('returns 422 when the same key is reused with a different payload', async () => { ... })
  ```
- **Formato fixo do marcador** (lido por `npm run check:trace`; fora dele, o requisito não conta como coberto):
  - uma linha só com `// REQ-<GRUPO>-<NN>`, ou vários IDs separados por `, `. Regex: `^\s*// REQ-[A-Z]+-\d{2}(, REQ-[A-Z]+-\d{2})*$`;
  - a linha seguinte (não vazia) é o `it(` ou `test(` com o nome do teste entre aspas simples;
  - intervalos (`REQ-API-01..05`) são proibidos em teste e permitidos só em mensagens de commit.
- No `requirements.md`, o requisito é identificado pelo cabeçalho `### REQ-<GRUPO>-<NN> [IMPLEMENTAR]` ou `[PROPOSTA PRODUÇÃO]`. Não altere esse formato.
- `npm run check:trace` falha se algum requisito `[IMPLEMENTAR]` não tiver marcador em `test/`, ou se `docs/specs/traceability.md` estiver desatualizado. `npm run check:trace -- --write` regenera a matriz. Ele verifica se **existe** teste para cada requisito, não a **qualidade** do teste.
- `npm run test:stress` roda os testes de concorrência 5 vezes seguidas e para na primeira falha. É obrigatório no fechamento da T-05 e da T-14.
- Testes de integração rodam contra Postgres real (docker compose), sempre no banco `orders_test`, com `TRUNCATE` entre testes. Nunca usar o banco de dev: o setup de testes aborta se o nome do banco em `TEST_DATABASE_URL` não terminar em `_test`. Sem mock de banco.
- O ERP é sempre o `FakeErpClient` com cenário injetável (`success`, `transient`, `permanent`, `timeout`, `processed_then_timeout`, `conflict_found`, `conflict_not_found`; consulta `auto` ou `unknown`).
- Testes de concorrência devem ser determinísticos (`Promise.all` com N requisições, dois workers disputando o mesmo pedido). Proibido depender de `sleep` para sincronizar.
- O worker expõe `runOnce()` para os testes dirigirem o processamento passo a passo, sem depender do polling.
