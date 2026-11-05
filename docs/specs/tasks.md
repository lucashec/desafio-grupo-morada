# Tarefas

Status: **APROVADO** (Fase 3, 2026-11-05). Fontes: `requirements.md` e `plan.md`.

## Regras de execução (Fase 4)
- Uma tarefa = um commit (Conventional Commits, citando T-xx e REQ-IDs).
- Ciclo por tarefa: teste primeiro (ver falhar) → mínimo para passar → `npm test && npm run typecheck && npm run lint` → commit → marcar `[x]` aqui → resumo de 3 linhas.
- Pausa para OK após T-03, T-06, T-09, T-12, ou imediatamente diante de ambiguidade ou conflito com a spec.
- Todo teste tem o marcador `// REQ-...` acima do `it`, no formato fixo definido no `CLAUDE.md` (sem intervalos). Os 8 testes obrigatórios estão marcados como **(Obr-n)**.
- Pronto, em toda tarefa, também significa: testes, typecheck e lint verdes, e nenhum TODO pendente nos arquivos tocados.

## Dependências

```
T-01 → T-02 → T-03 → T-04 → T-05
              T-06 (só depende de T-01)
              T-07 (só depende de T-01)
T-05 + T-06 + T-07 → T-08 → T-09 → T-10 → T-11 → T-12 → T-13 → T-14
```

---

### [x] T-01: Scaffold, docker compose e configuração
- **Objetivo:** projeto TS strict com Fastify, Zod, pg, pino e Vitest. Postgres via compose com `orders_dev` e `orders_test`. Configuração validada por env.
- **REQ:** REQ-CONC-06, REQ-SEC-04
- **Arquivos:** `package.json` (inclui os scripts `test:stress` e `check:trace`, que apontam para arquivos criados depois), `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml`, `docker/initdb/01-create-test-db.sql`, `src/config.ts`, `test/unit/config.test.ts`
- **Teste:** `unit/config.test.ts`: configuração válida carrega com padrões; `LEASE_MS=10000`, `ERP_TIMEOUT_MS=5000` e `ERP_LOOKUP_TIMEOUT_MS=3000` falham com mensagem sobre a regra; variável inválida falha citando o **nome** e não o valor.
- **Pronto quando:** `npm install`, `docker compose up -d db`, `npm test`, `npm run typecheck` e `npm run lint` funcionam; scripts `dev`, `migrate`, `test`, `lint` e `typecheck` existem; `.env.example` não tem segredo real.
- **Commit:** `chore(scaffold): T-01 project setup, compose and env config [REQ-CONC-06, REQ-SEC-04]`

### [x] T-02: Migrations e infraestrutura de teste do banco
- **Objetivo:** `001_init.sql` (DDL do plano §3), runner de migrations e helpers de teste com a trava `_test` e `TRUNCATE`.
- **REQ:** REQ-IDEM-01 (constraint), REQ-STATE-03 (base: CHECKs)
- **Arquivos:** `src/infra/db/pool.ts`, `src/infra/db/migrate.ts`, `src/infra/db/migrations/001_init.sql`, `test/helpers/db.ts`, `test/global-setup.ts`, `test/integration/schema.test.ts`
- **Teste:** `integration/schema.test.ts`: segundo `INSERT` com a mesma `idempotency_key` viola `orders_idempotency_key_uq`; `PROCESSING` sem lease viola CHECK; `SENT` sem `erp_order_id` viola CHECK; o helper recusa URL cujo banco não termina em `_test`; `migrate` roda duas vezes sem erro.
- **Pronto quando:** `npm run migrate` aplica no banco de dev; a suíte aplica em `orders_test` e trunca entre testes.
- **Commit:** `feat(db): T-02 schema, migrations and test db guard [REQ-IDEM-01, REQ-STATE-03]`

### [x] T-03: Esqueleto HTTP (erros, correlation id, limites, health)
- **Objetivo:** `buildApp`, formato padrão de erro, `X-Correlation-Id`, `bodyLimit` 32 KB, 415, `GET /health`, `server.ts` (API + graceful shutdown) e logger base.
- **REQ:** REQ-API-06, REQ-API-07, REQ-SEC-01, REQ-SEC-02, REQ-OBS-02 (parte HTTP)
- **Arquivos:** `src/app.ts`, `src/server.ts`, `src/logger.ts`, `src/http/errors.ts`, `src/http/correlation.ts`, `src/http/health.routes.ts`, `test/helpers/app.ts`, `test/integration/http-base.test.ts`
- **Teste:** `integration/http-base.test.ts` (via `app.inject`): health 200 e 503 com pool encerrado; erro inesperado → 500 `INTERNAL_ERROR` sem `stack`; body de 40 KB → 413; `text/plain` → 415; correlation id válido ecoado, inválido substituído por UUID.
- **Pronto quando:** `npm run dev` sobe e responde `/health`; SIGTERM encerra limpo.
- **Commit:** `feat(http): T-03 app skeleton, error format, limits and health [REQ-API-06, REQ-API-07, REQ-SEC-01, REQ-SEC-02, REQ-OBS-02]`

> ⏸ Pausa para OK.

### [x] T-04: POST /orders (validação + persistência) e GET /orders/:id
- **Objetivo:** schema Zod estrito, validação da `Idempotency-Key`, `INSERT` + evento `CREATED`, 202 + `Location`; GET com histórico sem payload; 404.
- **REQ:** REQ-API-01, REQ-API-02, REQ-API-03, REQ-API-04, REQ-API-05, REQ-SEC-03
- **Arquivos:** `src/domain/order.ts`, `src/http/orders.routes.ts`, `src/infra/db/orders.repo.ts`, `test/helpers/fixtures.ts`, `test/integration/orders-api.test.ts`
- **Teste:** `integration/orders-api.test.ts`: 202 com `id`, `PENDING`, `Location`, 1 linha e 1 evento; 400 para `items` vazio, `quantity=0`, campo extra e `document` com 10 dígitos, com `details` sem o valor recebido; 400 sem a chave, com chave de 129 caracteres e com chave com espaço; GET 200 com `events` e sem `customer`/`document`/`email`/`notes`; 404 para `abc` e para UUID inexistente.
- **Pronto quando:** fluxo feliz e validações passam; nenhum SQL concatenado.
- **Commit:** `feat(orders): T-04 create and read order endpoints [REQ-API-01..05, REQ-SEC-03]`

### [x] T-05: Idempotência (ON CONFLICT + request_hash) e concorrência no POST
- **Objetivo:** hash canônico; `INSERT ... ON CONFLICT DO NOTHING` com o evento na mesma instrução; replay 200 com estado atual; 422 para hash divergente.
- **REQ:** REQ-IDEM-01, REQ-IDEM-02, REQ-IDEM-03, REQ-CONC-01, REQ-CONC-02
- **Arquivos:** `src/domain/request-hash.ts`, `src/infra/db/orders.repo.ts`, `src/http/orders.routes.ts`, `test/unit/request-hash.test.ts`, `test/integration/idempotency.test.ts`, `test/integration/concurrency-post.test.ts`
- **Teste:**
  - `unit/request-hash.test.ts`: reordenar chaves não muda o hash; mudar um valor muda.
  - `integration/idempotency.test.ts`: **(Obr-2)** mesma chave com payload diferente → 422 e original intacto; replay → 200, `Idempotent-Replayed: true`, mesmo `id`; replay após forçar `SENT` via SQL → `status = SENT`.
  - `integration/concurrency-post.test.ts`: **(Obr-1)** N=20 POSTs em `Promise.all` → 1 linha em `orders`, 1 `CREATED`, 1×202 **sem** o header `Idempotent-Replayed`, 19×200 **todas** com `Idempotent-Replayed: true`, e o mesmo `id` nas 20 respostas; 10 concorrentes misturando P1/P2 → 1 pedido, divergentes com 422.
  - Regras: N entre 10 e 20; `TRUNCATE` antes de cada teste (helper de T-02); nenhum `sleep`/`setTimeout`; verificação só sobre o estado final (banco + respostas), nunca sobre a ordem de chegada.
- **Pronto quando:** `npm run test:stress` (5 execuções seguidas de `test/integration/concurrency-*.test.ts`, parando na primeira falha; na T-14 ele cobre `concurrency-post`, `concurrency-worker` e `concurrency-reprocess`) passa no fechamento da tarefa. Fora da T-05 e da T-14, o stress não é obrigatório.
- **Commit:** `feat(idempotency): T-05 unique key + request hash [REQ-IDEM-01..03, REQ-CONC-01, REQ-CONC-02]`

### [x] T-06: Máquina de estados
- **Objetivo:** `TRANSITIONS` e `assertTransition` no domínio, como função pura.
- **REQ:** REQ-STATE-01, REQ-STATE-02
- **Arquivos:** `src/domain/state-machine.ts`, `test/unit/state-machine.test.ts`
- **Teste:** `unit/state-machine.test.ts`: os 11 pares válidos são aceitos; todos os outros pares do produto 7×7 são rejeitados com `InvalidTransitionError`, incluindo toda saída de `SENT`.
- **Pronto quando:** o teste percorre o produto cartesiano completo (nada de lista manual de inválidos).
- **Commit:** `feat(domain): T-06 order state machine [REQ-STATE-01, REQ-STATE-02]`

> ⏸ Pausa para OK.

### [ ] T-07: Contrato ErpClient, classificação, timeout e FakeErpClient
- **Objetivo:** tipos `CreateOrderResult`/`LookupResult` (`AMBIGUOUS`, `UNKNOWN`), `classifyCreate`/`classifyLookup`, `callWithTimeout`, fake com filas de cenários, registro, contadores, hook e `hang()`.
- **REQ:** REQ-ERP-07, REQ-ERP-08, REQ-ERP-09
- **Arquivos:** `src/infra/erp/erp-client.ts`, `src/infra/erp/classify.ts`, `src/infra/erp/call-with-timeout.ts`, `src/infra/erp/fake-erp-client.ts`, `test/unit/classify.test.ts`, `test/unit/call-with-timeout.test.ts`, `test/unit/fake-erp.test.ts`
- **Teste:**
  - `unit/classify.test.ts`: tabela com 200, 201, 400, 404, 408, 409, 422, 429, 500, 503, ECONNREFUSED, ECONNRESET e TIMEOUT, para criação e para consulta.
  - `unit/call-with-timeout.test.ts`: com `vi.useFakeTimers` e fake pendurado, a criação resulta em `AMBIGUOUS{TIMEOUT}` e a consulta em `UNKNOWN`; o timer é limpo quando a chamada resolve antes.
  - `unit/fake-erp.test.ts`: cada cenário (`processed_then_timeout` grava e devolve ambíguo; `conflict_found` registra uma vez e a consulta acha; `conflict_not_found` não registra e a consulta não acha; `unknown` na consulta); contadores; o último cenário se repete.
- **Pronto quando:** `switch` exaustivo compila com `never`; o fake não depende do banco.
- **Commit:** `feat(erp): T-07 erp client contract, classifier and fake [REQ-ERP-07..09]`

### [ ] T-08: Worker com claim/lease e desfechos SUCCESS/PERMANENT
- **Objetivo:** `claimNextOrder` (SKIP LOCKED, lease, `attempts+1`, `ATTEMPT_STARTED`), `finalizeAttempt` guardado por `lease_token`, `runOnce`/`start`/`stop`, `process-order` para `SUCCESS` e `PERMANENT_ERROR`, worker ligado no `server.ts`.
- **REQ:** REQ-ERP-01, REQ-ERP-02, REQ-ERP-03, REQ-CONC-03, REQ-RETRY-06, REQ-IDEM-04, REQ-STATE-03, REQ-STATE-04
- **Arquivos:** `src/worker/worker.ts`, `src/worker/process-order.ts`, `src/infra/db/orders.repo.ts`, `src/server.ts`, `test/helpers/worker.ts` (`makeDue`, `expireLease`, `buildWorker`), `test/integration/worker-outcomes.test.ts`, `test/integration/concurrency-worker.test.ts`
- **Teste:**
  - `integration/worker-outcomes.test.ts`: `success` → `SENT`, `erpOrderId` preenchido e `createdCount=1`; **(Obr-3)** `permanent` → `FAILED`/`ERP_REJECTED`, `runOnce` 2× e 1 chamada; o hook do fake lê o banco durante a chamada e vê `PROCESSING`, `attempts=1` e `ATTEMPT_STARTED`; `RETRY_SCHEDULED` com due futuro não é reivindicado; `SENT` nunca é reivindicado; toda chamada usa `reference = order.id`.
  - `integration/concurrency-worker.test.ts`: **(Obr-6)** 1 pedido e 2 workers em `Promise.all(runOnce)` → 1 chamada de criação e 1 `ATTEMPT_STARTED`; transação externa segurando o lock de um pedido → o worker pula para o próximo (SKIP LOCKED) sem bloquear.
- **Pronto quando:** o ERP nunca é chamado com transação aberta (revisão + teste do hook).
- **Commit:** `feat(worker): T-08 claim with lease and terminal outcomes [REQ-ERP-01..03, REQ-CONC-03, REQ-RETRY-06, REQ-IDEM-04, REQ-STATE-03, REQ-STATE-04]`

### [ ] T-09: Retry com backoff exponencial + jitter
- **Objetivo:** `computeDelay` com `random` injetável, piso para ambíguo, desfecho `TRANSIENT_ERROR` → `RETRY_SCHEDULED` ou `FAILED`/`RETRIES_EXHAUSTED`.
- **REQ:** REQ-RETRY-01, REQ-RETRY-02, REQ-RETRY-03, REQ-ERP-04
- **Arquivos:** `src/domain/backoff.ts`, `src/worker/process-order.ts`, `test/unit/backoff.test.ts`, `test/integration/retry.test.ts`
- **Teste:**
  - `unit/backoff.test.ts`: `random=1` → 1000/2000/4000/60000; `random=0` → 0; piso ambíguo → 1000.
  - `integration/retry.test.ts`: **(Obr-4)** `[transient, transient, success]` com `makeDue` entre rodadas → `SENT`, `attempts=3`, `createdCount=1`; `transient` sempre com `MAX_ATTEMPTS=3` → `FAILED`/`RETRIES_EXHAUSTED` e 3 chamadas; após 1 transitório, `RETRY_SCHEDULED` e `nextAttemptAt > now`.
- **Pronto quando:** nenhum teste depende de esperar o backoff real.
- **Commit:** `feat(retry): T-09 exponential backoff with full jitter [REQ-RETRY-01..03, REQ-ERP-04]`

> ⏸ Pausa para OK.

### [ ] T-10: Resultados ambíguos e reconciliação (timeout e 409)
- **Objetivo:** `AMBIGUOUS{TIMEOUT}` → `UNCERTAIN`; consulta antes de reenviar (`FOUND`/`NOT_FOUND`/`UNKNOWN`); `AMBIGUOUS{CONFLICT}` + consulta na mesma tentativa; esgotamento → `NEEDS_REVIEW`.
- **REQ:** REQ-ERP-05, REQ-ERP-06, REQ-ERP-11, REQ-RETRY-04
- **Arquivos:** `src/worker/process-order.ts`, `src/infra/db/orders.repo.ts` (evento intermediário), `test/integration/ambiguity.test.ts`
- **Teste:** `integration/ambiguity.test.ts`:
  - **(Obr-5)** `processed_then_timeout` → `UNCERTAIN` → `makeDue` → consulta `FOUND` → `SENT`, `createdCount = 1`, 1 criação e 1 consulta.
  - `timeout` sem gravação → consulta `NOT_FOUND` → reenvio `success` → `SENT`, `createdCount=1`.
  - Consulta `unknown` → `UNCERTAIN`, sem `createOrder`.
  - `MAX_ATTEMPTS=3`, criação `timeout` e consulta sempre `unknown` → `NEEDS_REVIEW`/`RECONCILIATION_EXHAUSTED`, 1 criação e 2 consultas.
  - `conflict_found` → `SENT`, `createdCount=1`.
  - `conflict_not_found` com `attempts=1` → `NEEDS_REVIEW`/`ERP_CONFLICT_NOT_FOUND` imediato.
  - `conflict` + consulta `unknown` → `UNCERTAIN`.
- **Pronto quando:** em nenhum cenário o fake registra mais de 1 pedido por referência.
- **Commit:** `feat(reconciliation): T-10 ambiguous outcomes and lookup before resend [REQ-ERP-05, REQ-ERP-06, REQ-ERP-11, REQ-RETRY-04]`

### [ ] T-11: Recuperação de lease, fencing e reclaim esgotado
- **Objetivo:** lease vencido tratado como ambíguo; gravação com lease perdido descartada com evento `LEASE_LOST`; caso B do claim (`attempts > MAX` → `NEEDS_REVIEW` sem tentativa).
- **REQ:** REQ-CONC-04, REQ-CONC-05, REQ-RETRY-05, REQ-STATE-03
- **Arquivos:** `src/infra/db/orders.repo.ts`, `src/worker/worker.ts`, `src/worker/process-order.ts`, `test/integration/lease.test.ts`
- **Teste:** `integration/lease.test.ts`:
  - **(Obr-7)** crash simulado (claim sem processar) + `expireLease` → `runOnce` consulta antes de enviar e termina em `SENT`, com `createdCount=1`. Variante: `processed_then_timeout` antes do crash.
  - Fencing: o hook do fake, durante a chamada do worker A, executa `expireLease` e `runOnce` do worker B. A grava com 0 linhas afetadas, evento com `error_code=LEASE_LOST` e `to_status=NULL`, log `LEASE_LOST`, e o status final vem de B.
  - `MAX_ATTEMPTS=3`, `attempts=3` e lease vencido → `NEEDS_REVIEW`/`LEASE_EXPIRED`, `attempts=4`, `ATTEMPT_ABANDONED` com `attempt=4`, nenhum `ATTEMPT_STARTED` com `attempt=4`, lease nulo, 0 criações e 0 consultas.
  - `attempts=2` e lease vencido → tentativa 3 normal, com consulta.
- **Pronto quando:** nenhum teste usa `sleep`; a expiração é feita via SQL.
- **Commit:** `feat(worker): T-11 lease recovery, fencing token and abandoned reclaim [REQ-CONC-04, REQ-CONC-05, REQ-RETRY-05, REQ-STATE-03]`

### [ ] T-12: Reprocessamento atômico
- **Objetivo:** `POST /orders/:id/reprocess` com `reason` opcional, decidido por um único `UPDATE ... WHERE status IN ('FAILED','NEEDS_REVIEW')` com o evento na CTE; leitura posterior só para 404/409.
- **REQ:** REQ-RETRY-07, REQ-RETRY-08, REQ-STATE-03
- **Arquivos:** `src/http/orders.routes.ts`, `src/infra/db/orders.repo.ts`, `test/integration/reprocess.test.ts`, `test/integration/concurrency-reprocess.test.ts`
- **Teste:** `integration/reprocess.test.ts`:
  - `FAILED` → 202 `PENDING`, `attempts=0`, `reason` no evento e eventos anteriores preservados.
  - `NEEDS_REVIEW` com pedido já no ERP → 202 `UNCERTAIN` → `runOnce` → consulta → `SENT` sem nova criação.
  - `PENDING`/`PROCESSING`/`RETRY_SCHEDULED`/`UNCERTAIN`/`SENT` → 409 com `currentStatus`, sem evento.
  - `reason` com 201 caracteres → 400; UUID inexistente → 404.
  - `integration/concurrency-reprocess.test.ts` (entra no `test:stress`): N=10 concorrentes partindo de `FAILED` e de `NEEDS_REVIEW` → 1×202, 9×409, 1 `REPROCESS_REQUESTED`.
  - Repetir após aceito → 409, sem evento.
- **Pronto quando:** não há SELECT antes do UPDATE no caminho de decisão (revisão de código).
- **Commit:** `feat(reprocess): T-12 atomic guarded reprocess endpoint [REQ-RETRY-07, REQ-RETRY-08, REQ-STATE-03]`

> ⏸ Pausa para OK.

### [ ] T-13: Observabilidade e proteção de dados nos logs
- **Objetivo:** `redact` completo, log de resposta próprio (sem body), loggers do worker com `correlationId`/`orderId`/`attempt`/`status`, correlation id propagado ao worker e aos eventos, truncamento de erros do ERP.
- **REQ:** REQ-OBS-01, REQ-OBS-02, REQ-OBS-03, REQ-OBS-04, REQ-OBS-05
- **Arquivos:** `src/logger.ts`, `src/app.ts`, `src/worker/*.ts`, `src/infra/erp/fake-erp-client.ts` (mensagem longa), `src/infra/db/orders.repo.ts` (truncamento), `test/helpers/log-capture.ts`, `test/integration/observability.test.ts`
- **Teste:** `integration/observability.test.ts`:
  - **(Obr-8)** `POST /orders` real (via `app.inject`, com app e worker usando o logger da captura) e payload com `document`/`email`/`name` reconhecíveis e únicos passa por criação, replay, 400, todos os cenários do fake, reprocess com `reason` marcado e GET; a **saída inteira** do stream de log (todas as linhas, todos os níveis) é varrida e não contém nenhum marcador.
  - `logger.info({ payload })` → `[REDACTED]`.
  - Todo log do worker sobre o pedido tem os 4 campos.
  - `X-Correlation-Id: abc-123` aparece nos eventos do worker.
  - Sequência de eventos de `processed_then_timeout` conforme REQ-OBS-03, com `duration_ms`.
  - Mensagem de erro do ERP com 1000 caracteres é gravada com ≤ 200.
- **Pronto quando:** a captura de logs usa um stream em memória injetado no pino (sem monkey-patch de `console`).
- **Commit:** `feat(observability): T-13 structured logs, redact and event trail [REQ-OBS-01..05]`

### [ ] T-14: Fechamento: rastreabilidade, README e revisão adversarial
- **Objetivo:** Fase 5 do processo.
- **REQ:** todos (verificação de cobertura); documenta REQ-IDEM-05, REQ-ERP-10, REQ-RETRY-09, REQ-OBS-06 e REQ-SEC-05 como proposta
- **Arquivos:** `scripts/check-traceability.mjs`, `docs/specs/traceability.md` (gerado), `README.md`
- **check:trace:**
  - Node puro (`fs`, `path`), **sem dependência nova** e com cerca de 40 linhas.
  - Lê os cabeçalhos `### REQ-..-NN [IMPLEMENTAR|PROPOSTA PRODUÇÃO]` do `requirements.md` e os marcadores `// REQ-...` de `test/**/*.test.ts`, no formato fixo do `CLAUDE.md`, com o nome do `it(`/`test(` seguinte.
  - Monta a matriz REQ-ID → teste → arquivo (proposta: "proposta, sem teste"; sem cobertura: "**SEM TESTE**").
  - `--write` grava `traceability.md`. Sem flag, compara com o arquivo e falha (exit 1) se ele estiver desatualizado, se houver requisito `[IMPLEMENTAR]` sem teste, se houver marcador citando um ID inexistente ou se houver **teste sem marcador** (`it(`, `test(`, `it.each(` ou `test.each(` cuja linha anterior não é `// REQ-…`).
  - A matriz é **gerada** pelo script: uma só fonte de verdade, sem edição manual. Notas manuais (ex.: revisão adversarial) ficam no README.
  - **Limite de esforço:** se passar de 1 h, descartar o script e escrever a matriz à mão, registrando a decisão aqui.
- **Teste:**
  - `npm run check:trace` roda limpo;
  - prova negativa manual registrada no commit: remover temporariamente um marcador faz o script falhar com o REQ-ID citado;
  - prova negativa específica de `it.each`: remover o marcador de um `it.each` (ex.: `unit/state-machine.test.ts`) faz o script falhar citando arquivo e linha do teste sem marcador;
  - `npm run test:stress` passa (5× seguidas);
  - suíte completa + typecheck + lint verdes.
- **Pronto quando:** o README tem comandos copiáveis, arquitetura, estratégia, diagrama do timeout, as seções "Implementado" e "Proposta para produção" separadas, "Garantias e limitações" a revisão adversarial com ≥ 5 riscos (coberto por teste? o que foi feito?) e uma nota explícita: "`check:trace` verifica que existe ao menos um teste por requisito; não avalia a qualidade nem a suficiência desses testes".
- **Commit:** `docs: T-14 traceability matrix, README and adversarial review`

---

## Cobertura dos testes obrigatórios

| Obr | Cenário | Tarefa | Arquivo |
|---|---|---|---|
| 1 | N concorrentes com mesma chave → 1 pedido | T-05 | integration/concurrency-post.test.ts |
| 2 | mesma chave + payload diferente → 422 | T-05 | integration/idempotency.test.ts |
| 3 | permanente → FAILED sem retry | T-08 | integration/worker-outcomes.test.ts |
| 4 | transitório → retry → SENT | T-09 | integration/retry.test.ts |
| 5 | ERP processa e dá timeout → contador 1 | T-10 | integration/ambiguity.test.ts |
| 6 | dois workers, só um processa | T-08 | integration/concurrency-worker.test.ts |
| 7 | lease expirado recupera após crash | T-11 | integration/lease.test.ts |
| 8 | dado sensível fora dos logs | T-13 | integration/observability.test.ts |
