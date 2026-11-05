# Requisitos: Integração confiável API -> ERP

Status: **APROVADO** (Fase 1, 2026-11-05), com as respostas Q-01..Q-12 já incorporadas.

## Convenções

- Formato EARS: "Quando <evento>, o sistema deve <resposta>". Requisitos sempre ativos usam "O sistema deve ...".
- IDs são estáveis: nunca reaproveitar um ID removido.
- Classificação:
  - **[IMPLEMENTAR]**: entra no código e tem teste automatizado.
  - **[PROPOSTA PRODUÇÃO]**: documentado no README como próximo passo; não implementado.
- Glossário:
  - **Pedido**: registro na tabela `orders`, identificado por `id` (UUID gerado pela API), que também é a **referência externa** enviada ao ERP.
  - **Chave de idempotência**: valor do header `Idempotency-Key`, escolhido pelo cliente.
  - **request_hash**: SHA-256 da representação JSON canônica (chaves ordenadas) do payload já validado.
  - **Tentativa**: uma execução do worker sobre um pedido (pode incluir consulta e/ou envio ao ERP). `attempts` conta reivindicações (claims), ver REQ-RETRY-05.
  - **Resultado ambíguo**: não se sabe se o ERP criou o pedido (timeout, `409` do ERP, ou crash do worker durante a chamada).

## Formato do pedido (aprovado em Q-01)

```json
{
  "customer": { "name": "string 1..120", "document": "CPF/CNPJ só dígitos, 11 ou 14", "email": "email" },
  "items": [ { "sku": "string 1..64", "quantity": "inteiro 1..10000", "unitPriceCents": "inteiro 0..100000000" } ],
  "notes": "string opcional 0..500"
}
```

`items` com 1 a 100 elementos. Campos desconhecidos são rejeitados. Valores monetários sempre em centavos inteiros (nunca float). `customer.document` é validado **apenas por formato** (11 ou 14 dígitos), sem dígito verificador. `customer.*` e `notes` são considerados **dados sensíveis** para fins de log.

---

## REQ-API: contrato e validação

### REQ-API-01 [IMPLEMENTAR]
Quando receber `POST /orders` com payload válido e `Idempotency-Key` inédita, o sistema deve persistir o pedido com status `PENDING`, registrar o evento `CREATED` e responder `202` com `{ id, status, createdAt }` e header `Location: /orders/{id}`.
- Given payload válido e chave inédita, When `POST /orders`, Then status 202, sem header `Idempotent-Replayed`, corpo contém `id` (UUID) e `status = PENDING`, e existe 1 linha em `orders` e 1 evento `CREATED`.
- Given o mesmo cenário, When a resposta é recebida, Then nenhuma chamada ao ERP ocorreu durante a requisição.

### REQ-API-02 [IMPLEMENTAR]
Quando receber `POST /orders` com payload que viola o schema, o sistema deve responder `400` com `{ error: { code: "VALIDATION_ERROR", message, details } }` e não persistir nada.
- Given `items` vazio, `quantity = 0`, campo desconhecido ou `customer.document` com 10 dígitos, When `POST /orders`, Then 400, `details` aponta o campo inválido, e `orders` continua vazia.
- Given erro de validação, When a resposta é gerada, Then `details` não ecoa o valor recebido (só caminho e regra).

### REQ-API-03 [IMPLEMENTAR]
Quando receber `POST /orders` sem `Idempotency-Key`, ou com valor fora de 1 a 128 caracteres do conjunto `[A-Za-z0-9_-]`, o sistema deve responder `400` com `code: "INVALID_IDEMPOTENCY_KEY"`.
- Given requisição sem o header, When `POST /orders`, Then 400 e nada é persistido.
- Given chave com 129 caracteres ou com espaço, When `POST /orders`, Then 400.

### REQ-API-04 [IMPLEMENTAR]
Quando receber `GET /orders/:id` de um pedido existente, o sistema deve responder `200` com `id`, `status`, `attempts`, `erpOrderId` (se houver), `lastError` (código + mensagem curta), `nextAttemptAt`, `createdAt`, `updatedAt` e `events` (histórico ordenado cronologicamente), sem incluir o payload do pedido.
- Given pedido com 2 tentativas, When `GET /orders/:id`, Then 200 e `events` lista as tentativas com `type`, `attempt`, `outcome`, `errorCode`, `durationMs`, `createdAt`.
- Given qualquer pedido, When `GET /orders/:id`, Then o corpo não contém `customer`, `document`, `email` nem `notes`.

### REQ-API-05 [IMPLEMENTAR]
Quando receber `GET /orders/:id` ou `POST /orders/:id/reprocess` com `id` que não é UUID válido ou não existe, o sistema deve responder `404` com `code: "ORDER_NOT_FOUND"`.
- Given `id = "abc"` ou UUID inexistente, When `GET /orders/:id`, Then 404.

### REQ-API-06 [IMPLEMENTAR]
Quando receber `GET /health`, o sistema deve executar `SELECT 1` no banco e responder `200 { status: "ok" }` se o banco responder, ou `503 { status: "unavailable" }` caso contrário.
- Given banco disponível, When `GET /health`, Then 200.
- Given pool de banco encerrado, When `GET /health`, Then 503.

### REQ-API-07 [IMPLEMENTAR]
O sistema deve responder erros sempre no formato `{ error: { code, message, details? } }`, sem stack trace nem mensagens internas do banco; erros inesperados viram `500` com `code: "INTERNAL_ERROR"`.
- Given falha inesperada em um handler, When a requisição é processada, Then 500 com `code = INTERNAL_ERROR` e sem `stack` no corpo.

---

## REQ-IDEM: idempotência

### REQ-IDEM-01 [IMPLEMENTAR]
O sistema deve garantir unicidade da chave de idempotência por restrição `UNIQUE(idempotency_key)` no banco, usando `INSERT ... ON CONFLICT DO NOTHING` seguido de leitura do registro existente, sem verificação prévia "SELECT-then-INSERT" na aplicação.
- Given chave já usada, When um novo `INSERT` com a mesma chave é executado, Then nenhuma segunda linha é criada (garantido pelo banco, não pela aplicação).

### REQ-IDEM-02 [IMPLEMENTAR]
Quando receber `POST /orders` com chave já existente e `request_hash` igual ao armazenado, o sistema deve responder `200` com header `Idempotent-Replayed: true` e corpo `{ id, status, createdAt }` refletindo o **estado atual** do pedido (não o da resposta original), sem criar pedido nem evento de criação.
- Given pedido criado com chave K e payload P, When `POST /orders` com K e P de novo, Then 200, mesmo `id`, header `Idempotent-Replayed: true`, e `orders` continua com 1 linha.
- Given pedido criado com K e P que já foi processado até `SENT`, When `POST /orders` com K e P, Then 200 com `status = SENT`.
- Given P reenviado com as chaves do JSON em outra ordem, When `POST /orders` com K, Then é tratado como o mesmo payload (hash canônico).

### REQ-IDEM-03 [IMPLEMENTAR]
Quando receber `POST /orders` com chave já existente e `request_hash` diferente, o sistema deve responder `422` com `code: "IDEMPOTENCY_KEY_REUSED"` e não alterar o pedido existente.
- Given pedido criado com K e P1, When `POST /orders` com K e P2 (ex.: outra `quantity`), Then 422 e o pedido original permanece inalterado.

### REQ-IDEM-04 [IMPLEMENTAR]
O sistema deve enviar ao ERP o `id` do pedido como referência externa estável em toda tentativa de criação e usá-lo em toda consulta, de modo que reenvios do mesmo pedido carreguem sempre a mesma referência.
- Given pedido com 3 tentativas, When o `FakeErpClient` registra as chamadas, Then todas usam `reference = order.id`.

### REQ-IDEM-05 [PROPOSTA PRODUÇÃO]
O sistema deveria expirar chaves de idempotência após um período de retenção (ex.: 30 dias) e escopá-las por cliente autenticado (`UNIQUE(client_id, idempotency_key)`).

---

## REQ-CONC: concorrência

### REQ-CONC-01 [IMPLEMENTAR]
Quando N requisições `POST /orders` com a mesma chave e o mesmo payload chegarem simultaneamente, o sistema deve criar exatamente 1 pedido e todas as respostas devem referenciar o mesmo `id`.
- Given N requisições (10 ≤ N ≤ 20; o teste usa 20) disparadas com `Promise.all` sobre tabelas truncadas, When todas terminam, Then existe 1 linha em `orders`, 1 evento `CREATED`, exatamente 1 resposta 202 **sem** o header `Idempotent-Replayed`, N-1 respostas 200 **todas** com `Idempotent-Replayed: true`, e o mesmo `id` nas N respostas. Sem sleeps; a verificação é feita só sobre o estado final.

### REQ-CONC-02 [IMPLEMENTAR]
Quando requisições simultâneas com a mesma chave e payloads diferentes chegarem, o sistema deve criar exatamente 1 pedido (o do primeiro `INSERT` confirmado) e responder `422` às demais com payload divergente.
- Given 10 requisições concorrentes com K, metade com P1 e metade com P2, When todas terminam, Then 1 pedido existe e toda resposta cujo payload difere do persistido é 422.

### REQ-CONC-03 [IMPLEMENTAR]
Quando dois ou mais workers tentarem reivindicar pedidos ao mesmo tempo, o sistema deve garantir que cada pedido seja reivindicado por no máximo um worker, usando `SELECT ... FOR UPDATE SKIP LOCKED`.
- Given 1 pedido `PENDING` e dois workers executando `runOnce()` em paralelo via `Promise.all`, When ambos terminam, Then o ERP recebeu exatamente 1 chamada de criação e só um worker registrou evento de tentativa.

### REQ-CONC-04 [IMPLEMENTAR]
O sistema deve registrar, a cada claim, um `lease_token` novo e `locked_until = now() + LEASE_MS`; toda gravação de resultado do worker deve exigir `status = 'PROCESSING' AND lease_token = <token do claim>`. Se nenhuma linha for afetada, o worker não aplica a transição, mas ainda registra o evento da chamada ao ERP (o fato "o ERP foi chamado" nunca se perde) com `to_status = NULL` e `error_code = "LEASE_LOST"`, além de um log de aviso `LEASE_LOST`.
- Given worker A reivindica o pedido, seu lease expira e worker B o reivindica e processa, When A tenta gravar o resultado, Then a gravação afeta 0 linhas, o status reflete apenas o processamento de B, existe o evento da chamada de A com `error_code = LEASE_LOST` e há log `LEASE_LOST`.

### REQ-CONC-05 [IMPLEMENTAR]
Quando um pedido estiver em `PROCESSING` com `locked_until` no passado (worker caiu), o sistema deve permitir que outro worker o reivindique e deve tratar a tentativa anterior como **resultado ambíguo** (ver REQ-ERP-06).
- Given pedido `PROCESSING` com `locked_until` vencido (crash simulado), When `runOnce()`, Then o pedido é reivindicado, o worker consulta o ERP pela referência antes de qualquer envio, e o pedido termina em estado final coerente.

### REQ-CONC-06 [IMPLEMENTAR]
O sistema deve recusar iniciar se `LEASE_MS` não for maior que `ERP_TIMEOUT_MS + 2 * ERP_LOOKUP_TIMEOUT_MS + 5000`, que é o pior caso de uma tentativa (consulta, criação e consulta após `409`) mais uma margem. Isso reduz o risco de o lease vencer com chamada ao ERP ainda em andamento.
- Given `LEASE_MS = 10000`, `ERP_TIMEOUT_MS = 5000` e `ERP_LOOKUP_TIMEOUT_MS = 3000`, When a configuração é carregada, Then a inicialização falha com mensagem explicando a regra.

---

## REQ-ERP: integração e classificação de erros

Contrato do cliente (detalhado no plano): `createOrder(reference, payload)` -> `SUCCESS{erpOrderId} | TRANSIENT_ERROR{code,message} | PERMANENT_ERROR{code,message} | AMBIGUOUS{cause}`, com `cause = TIMEOUT | CONFLICT`; `lookupByReference(reference)` -> `FOUND{erpOrderId} | NOT_FOUND | UNKNOWN{code,message}` (`UNKNOWN` = a consulta não conseguiu responder: timeout, `5xx`, conexão). O contrato tem quatro tipos de resultado de criação (Q-09): o `409` é `AMBIGUOUS{cause: CONFLICT}`.

Regras de decisão para resultados ambíguos (resumo de REQ-ERP-05/06/11):

| Situação | lookup `FOUND` | lookup `NOT_FOUND` | lookup `UNKNOWN` |
|---|---|---|---|
| `AMBIGUOUS{TIMEOUT}` (consultado na tentativa seguinte) | `SENT` | reenvia (`createOrder`) | `UNCERTAIN` + backoff |
| `AMBIGUOUS{CONFLICT}` (consultado na mesma tentativa) | `SENT` | `NEEDS_REVIEW` imediato | `UNCERTAIN` + backoff |
| Lease vencido (consultado no reclaim) | `SENT` | reenvia | `UNCERTAIN` + backoff |

### REQ-ERP-01 [IMPLEMENTAR]
O sistema deve persistir o status `PROCESSING` (com lease), o incremento de `attempts` e o evento `ATTEMPT_STARTED` (com o número da tentativa e o status anterior) em transação confirmada **antes** de qualquer chamada ao ERP, e nunca chamar o ERP dentro de uma transação de banco aberta.
- Given pedido `PENDING`, When o worker chama o ERP, Then no momento da chamada o banco já mostra `status = PROCESSING`, `attempts = 1` e o evento `ATTEMPT_STARTED` (verificado por um hook do `FakeErpClient` que lê o banco antes de responder).
- Given worker que "cai" logo depois do claim (crash simulado: o teste reivindica e não chama o ERP), When o banco é inspecionado, Then o evento `ATTEMPT_STARTED` existe e permite saber que uma tentativa pode ter chegado ao ERP.

### REQ-ERP-02 [IMPLEMENTAR]
Quando o ERP retornar `SUCCESS`, o sistema deve mudar o pedido para `SENT`, gravar `erp_order_id`, limpar o lease e registrar evento com `outcome = SUCCESS` e `duration_ms`.
- Given cenário `success`, When `runOnce()`, Then `status = SENT`, `erpOrderId` preenchido e contador do ERP = 1.

### REQ-ERP-03 [IMPLEMENTAR]
Quando o ERP retornar `PERMANENT_ERROR`, o sistema deve mudar o pedido para `FAILED` com `last_error_code = "ERP_REJECTED"` e `last_error_message` com a mensagem curta do ERP, registrar o código original do ERP no evento e não agendar nova tentativa.
- Given cenário `permanent`, When `runOnce()` é chamado duas vezes, Then `status = FAILED`, `lastError.code = ERP_REJECTED`, `nextAttemptAt = null`, o evento `ERP_CREATE` tem o código original do ERP e o ERP recebeu exatamente 1 chamada.

### REQ-ERP-04 [IMPLEMENTAR]
Quando o ERP retornar `TRANSIENT_ERROR`, o sistema deve aplicar a política de retry (REQ-RETRY-02/03).
- Given cenário `transient` nas 2 primeiras chamadas e `success` depois, When `runOnce()` é chamado até o pedido estabilizar (com `next_attempt_at` antecipado pelo teste), Then `status = SENT`, `attempts = 3` e contador de pedidos criados no ERP = 1.

### REQ-ERP-05 [IMPLEMENTAR]
Quando a chamada `createOrder` resultar em `AMBIGUOUS{cause: TIMEOUT}`, o sistema deve mudar o pedido para `UNCERTAIN`, agendar reconciliação em `next_attempt_at` (backoff de REQ-RETRY-01) e **não** reenviar o pedido na mesma tentativa.
- Given cenário `timeout`, When `runOnce()`, Then `status = UNCERTAIN`, `nextAttemptAt` no futuro e o ERP recebeu exatamente 1 chamada de criação.

### REQ-ERP-06 [IMPLEMENTAR]
Quando o worker reivindicar um pedido cujo status anterior era `UNCERTAIN` ou `PROCESSING` com lease vencido, o sistema deve chamar `lookupByReference(order.id)` antes de qualquer `createOrder`:
- `FOUND` -> `SENT` com o `erpOrderId` retornado, sem chamar `createOrder`;
- `NOT_FOUND` -> seguir com `createOrder` na mesma tentativa (o resultado segue as regras normais, inclusive REQ-ERP-11);
- `UNKNOWN` -> permanecer `UNCERTAIN` com backoff (sem `createOrder`).

Critérios:
- Given cenário `processed_then_timeout` (ERP grava o pedido e responde timeout), When `runOnce()` é chamado até estabilizar, Then `status = SENT`, `erpOrderId` igual ao gravado pelo ERP e **contador de pedidos criados no ERP = 1**.
- Given cenário `timeout` em que o ERP não gravou o pedido, When a reconciliação roda, Then `lookup` retorna `NOT_FOUND`, `createOrder` é chamado e, com `success`, o pedido termina `SENT` com contador = 1.
- Given `lookup` retornando `UNKNOWN` (timeout ou `5xx` na consulta), When a reconciliação roda, Then `status = UNCERTAIN`, `nextAttemptAt` no futuro e nenhum `createOrder` foi chamado.

### REQ-ERP-07 [IMPLEMENTAR]
O sistema deve classificar respostas do ERP por uma função pura: `2xx` -> `SUCCESS`; `400`, `404`, `422` e demais `4xx` exceto `408`/`409`/`429` -> `PERMANENT_ERROR`; `5xx`, `408`, `429` e conexão recusada/reset -> `TRANSIENT_ERROR`; timeout de leitura -> `AMBIGUOUS{TIMEOUT}`; `409` (referência já existe) -> `AMBIGUOUS{CONFLICT}`, resolvido por consulta (REQ-ERP-11). Para consultas: `2xx` com pedido -> `FOUND`; `404` -> `NOT_FOUND`; qualquer outro resultado (timeout, `5xx`, conexão, `4xx` inesperado) -> `UNKNOWN`.
- Given a tabela de casos (200, 201, 400, 404, 408, 409, 422, 429, 500, 503, ECONNREFUSED, ECONNRESET, timeout), When classificados, Then cada um mapeia para o resultado esperado.

### REQ-ERP-08 [IMPLEMENTAR]
O sistema deve impor timeout do lado do cliente nas chamadas ao ERP (`ERP_TIMEOUT_MS` para criação, `ERP_LOOKUP_TIMEOUT_MS` para consulta) e tratar o estouro como `AMBIGUOUS{TIMEOUT}` na criação e `UNKNOWN{code: "ERP_LOOKUP_TIMEOUT"}` na consulta.
- Given `FakeErpClient` que demora mais que `ERP_TIMEOUT_MS` (promessa que só resolve quando o teste libera), When `createOrder` é chamado, Then o resultado é `AMBIGUOUS{TIMEOUT}`.
- Given o mesmo para `lookupByReference` e `ERP_LOOKUP_TIMEOUT_MS`, Then o resultado é `UNKNOWN`.

### REQ-ERP-09 [IMPLEMENTAR]
O sistema deve oferecer um `FakeErpClient` com cenários injetáveis por chamada de criação (`success`, `transient`, `permanent`, `timeout`, `processed_then_timeout`, `conflict_found`, `conflict_not_found`) e por chamada de consulta (`auto`, que responde pelo registro, ou `unknown`), que mantém um registro de pedidos criados indexado pela referência e expõe contadores de chamadas de criação, consulta e de pedidos efetivamente criados.
- Given cenário `processed_then_timeout`, When `createOrder` é chamado, Then o pedido aparece no registro do fake e o retorno é `AMBIGUOUS{TIMEOUT}`.
- Given cenário `conflict_found`, When `createOrder` é chamado, Then o retorno é `AMBIGUOUS{CONFLICT}` e a referência passa a constar no registro, simulando um pedido que o ERP criou antes (contado uma única vez); a consulta seguinte retorna `FOUND`.
- Given cenário `conflict_not_found`, When `createOrder` é chamado, Then o retorno é `AMBIGUOUS{CONFLICT}`, o registro não muda e a consulta seguinte retorna `NOT_FOUND`.
- O fake aceita a opção `honorsReference` (padrão `true`). Com `true`, o ERP deduplica pela referência: uma criação que grava (`success`, `processed_then_timeout`) para uma referência já registrada não cria outro pedido e devolve o `erpOrderId` existente. Com `false`, o ERP não deduplica: cada criação que grava conta como um pedido novo. Isso permite provar que o sistema evita duplicidade sem depender do ERP. `createdCount` conta pedidos efetivamente criados (com `true`, é igual a `registry.size`).
- Given `honorsReference = true` e dois `createOrder` com `success` para a mesma referência, Then `createdCount = 1` e os dois retornos têm o mesmo `erpOrderId`.
- Given `honorsReference = false` e o mesmo par de chamadas, Then `createdCount = 2`.

### REQ-ERP-10 [PROPOSTA PRODUÇÃO]
O sistema deveria ter um `HttpErpClient` real (com `undici`/`fetch`, `AbortSignal.timeout`, TLS/mTLS e credenciais via secret manager), mantendo o mesmo contrato tipado e a mesma função de classificação.

### REQ-ERP-11 [IMPLEMENTAR]
Quando `createOrder` resultar em `AMBIGUOUS{cause: CONFLICT}` (`409`, o ERP afirma que a referência já existe), o sistema deve chamar `lookupByReference` na mesma tentativa:
- `FOUND` -> `SENT` com o `erpOrderId` retornado;
- `NOT_FOUND` -> `NEEDS_REVIEW` **imediato**, independentemente das tentativas restantes, com `last_error_code = "ERP_CONFLICT_NOT_FOUND"` (o ERP se contradiz; reenviar não resolve);
- `UNKNOWN` -> `UNCERTAIN` com backoff (a próxima tentativa consulta de novo, conforme REQ-ERP-06).

Critérios:
- Given cenário `conflict_found`, When `runOnce()`, Then `status = SENT`, `erpOrderId` igual ao do registro, `createdCount = 1`, e houve 1 criação e 1 consulta.
- Given cenário `conflict_not_found` com `attempts = 1` e `MAX_ATTEMPTS = 5`, When `runOnce()`, Then `status = NEEDS_REVIEW`, `lastError.code = ERP_CONFLICT_NOT_FOUND`, `nextAttemptAt = null` e `createdCount = 0`.
- Given cenário `conflict_not_found` com consulta `unknown`, When `runOnce()`, Then `status = UNCERTAIN` com `nextAttemptAt` no futuro.

---

## REQ-RETRY: backoff, limites e reprocessamento

### REQ-RETRY-01 [IMPLEMENTAR]
O sistema deve calcular o atraso da próxima tentativa com backoff exponencial e *full jitter*: `delay = random(0, min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2^(attempt-1)))`. Padrões: `RETRY_BASE_DELAY_MS = 1000`, `RETRY_MAX_DELAY_MS = 60000`, `MAX_ATTEMPTS = 5`, todos configuráveis por variável de ambiente.
- Given `random` injetado retornando 1.0 (limite superior), When attempt = 1, 2, 3, 10, Then atrasos = 1000, 2000, 4000, 60000.
- Given `random` retornando 0.0, When qualquer attempt, Then atraso = 0.
- Para reconciliação de pedido ambíguo (`UNCERTAIN`), o atraso tem piso `RETRY_BASE_DELAY_MS`: `delay = max(RETRY_BASE_DELAY_MS, backoff)`. Esse é o "atraso mínimo" que mitiga a P-03. Given `random = 0.0` e resultado ambíguo, Then atraso = 1000.

### REQ-RETRY-02 [IMPLEMENTAR]
Quando ocorrer `TRANSIENT_ERROR` e `attempts < MAX_ATTEMPTS`, o sistema deve mudar o pedido para `RETRY_SCHEDULED` com `next_attempt_at = now() + delay`.
- Given cenário `transient` e attempts = 1, When `runOnce()`, Then `status = RETRY_SCHEDULED` e `nextAttemptAt > now`.

### REQ-RETRY-03 [IMPLEMENTAR]
Quando ocorrer `TRANSIENT_ERROR` e `attempts >= MAX_ATTEMPTS`, o sistema deve mudar o pedido para `FAILED` com `last_error_code = "RETRIES_EXHAUSTED"` (o código original do ERP fica no evento). O código distingue esse caso de `ERP_REJECTED` (REQ-ERP-03), embora ambos terminem em `FAILED`.
- Given `MAX_ATTEMPTS = 3` e cenário sempre `transient`, When `runOnce()` é chamado até estabilizar, Then `status = FAILED`, `lastError.code = RETRIES_EXHAUSTED`, `attempts = 3` e o ERP recebeu 3 chamadas.

### REQ-RETRY-04 [IMPLEMENTAR]
Quando a reconciliação de um pedido ambíguo esgotar `MAX_ATTEMPTS` sem resposta conclusiva, o sistema deve mudar o pedido para `NEEDS_REVIEW` com `last_error_code = "RECONCILIATION_EXHAUSTED"` (nunca `FAILED`, pois o pedido pode existir no ERP).
- Given `MAX_ATTEMPTS = 3` e criação `timeout` e consulta sempre `unknown`, When `runOnce()` é chamado até estabilizar, Then `status = NEEDS_REVIEW`, `attempts = 3`, o ERP recebeu exatamente 1 chamada de criação (a primeira) e 2 consultas.

### REQ-RETRY-05 [IMPLEMENTAR]
`attempts` conta **reivindicações** (claims): o `UPDATE` de claim sempre incrementa o contador, numa única instrução e sem ramificação. Por isso, **é esperado que `attempts > MAX_ATTEMPTS`** quando um lease vence depois que as tentativas já se esgotaram (ex.: `MAX_ATTEMPTS = 5` e o worker caiu durante a 5ª tentativa: o reclaim deixa `attempts = 6`). Esse valor registra que houve uma reivindicação além do limite. Ele não significa uma chamada a mais ao ERP.

Quando um worker reivindicar um pedido com lease vencido (status anterior `PROCESSING`) e o contador resultante passar de `MAX_ATTEMPTS`, o sistema **não deve iniciar uma nova tentativa**. Na mesma transação do claim, ele deve: mover o pedido para `NEEDS_REVIEW` com `last_error_code = "LEASE_EXPIRED"`, limpar o lease, registrar o evento `ATTEMPT_ABANDONED` (e **não** `ATTEMPT_STARTED`) e não chamar o ERP. O pedido não chega ao código que fala com o ERP. Isso protege contra um pedido que derruba o worker em loop.
- Given `MAX_ATTEMPTS = 3` e pedido `PROCESSING` com `attempts = 3` e lease vencido (crash simulado), When `runOnce()`, Then `status = NEEDS_REVIEW`, `attempts = 4`, `lastError.code = LEASE_EXPIRED`, `lease_token` e `locked_until` nulos, existe 1 evento `ATTEMPT_ABANDONED` com `attempt = 4`, não existe `ATTEMPT_STARTED` com `attempt = 4`, e o ERP recebeu 0 chamadas de criação e 0 de consulta.
- Given `MAX_ATTEMPTS = 3` e pedido `PROCESSING` com `attempts = 2` e lease vencido, When `runOnce()`, Then a tentativa 3 é iniciada normalmente (`ATTEMPT_STARTED`, consulta antes do reenvio).

### REQ-RETRY-06 [IMPLEMENTAR]
O worker deve reivindicar somente pedidos em `PENDING`, ou em `RETRY_SCHEDULED`/`UNCERTAIN` com `next_attempt_at <= now()`, ou em `PROCESSING` com `locked_until < now()`, usando sempre o relógio do banco (`now()`).
- Given pedido `RETRY_SCHEDULED` com `next_attempt_at` no futuro, When `runOnce()`, Then nada é reivindicado.

### REQ-RETRY-07 [IMPLEMENTAR]
Quando receber `POST /orders/:id/reprocess` (body opcional `{ "reason": string 1..200 }`) para pedido em `FAILED` ou `NEEDS_REVIEW`, o sistema deve mover `FAILED -> PENDING` ou `NEEDS_REVIEW -> UNCERTAIN` (forçando consulta antes de reenvio) com **um único `UPDATE` atômico**: `UPDATE orders SET status = CASE status WHEN 'FAILED' THEN 'PENDING' ELSE 'UNCERTAIN' END, ... WHERE id = $1 AND status IN ('FAILED','NEEDS_REVIEW') RETURNING ...`, com o `INSERT` do evento na mesma instrução (CTE). Nunca usar SELECT seguido de UPDATE para decidir. O mesmo `UPDATE` zera `attempts`, limpa `last_error_*` e define `next_attempt_at = now()`. O evento `REPROCESS_REQUESTED` guarda o `reason` (se enviado) e todos os eventos anteriores são preservados (o motivo da falha anterior já está neles). Resposta: `202` com `{ id, status }`.
- Given pedido `FAILED` com 3 eventos, When reprocess com `reason = "ERP corrigido"`, Then 202, `status = PENDING`, `attempts = 0`, o evento `REPROCESS_REQUESTED` guarda o `reason` e os 3 eventos anteriores continuam lá.
- Given `reason` com 201 caracteres ou campo desconhecido no body, When reprocess, Then 400.
- O `reason` é texto livre: fica no evento, mas nunca vai para os logs.
- Given pedido `NEEDS_REVIEW` cujo pedido existe no ERP, When reprocess e `runOnce()`, Then `lookup` é chamado, `status = SENT` e o contador de criados no ERP não aumenta.

### REQ-RETRY-08 [IMPLEMENTAR]
Quando receber `POST /orders/:id/reprocess` para pedido em `PENDING`, `PROCESSING`, `RETRY_SCHEDULED`, `UNCERTAIN` ou `SENT`, o sistema deve responder `409` com `code: "INVALID_STATE_TRANSITION"`, o status atual em `details.currentStatus`, e não alterar o pedido nem registrar evento. A decisão pelo `409` vem **exclusivamente** de o `UPDATE` atômico de REQ-RETRY-07 afetar 0 linhas. Só depois disso uma leitura distingue `404` (pedido inexistente) de `409` e preenche `currentStatus`; essa leitura nunca decide se a transição acontece.

O reprocess é **idempotente em efeito**: chamadas repetidas ou concorrentes para o mesmo pedido produzem no máximo uma transição e um evento `REPROCESS_REQUESTED` por ocorrência de `FAILED`/`NEEDS_REVIEW`.
- Given pedido `SENT`, When reprocess, Then 409, `details.currentStatus = SENT` e status continua `SENT`.
- Given pedido `FAILED` e N = 10 reprocess concorrentes via `Promise.all`, When terminam, Then exatamente 1 resposta 202, N-1 = 9 respostas 409 e exatamente 1 evento `REPROCESS_REQUESTED`. O mesmo vale partindo de `NEEDS_REVIEW`.
- Given reprocess já aceito (pedido agora `PENDING`), When o mesmo reprocess é repetido, Then 409 e nenhum evento novo.

### REQ-RETRY-09 [PROPOSTA PRODUÇÃO]
O sistema deveria alertar quando houver pedidos em `NEEDS_REVIEW` ou `UNCERTAIN` há mais de X minutos, oferecer ferramenta de conciliação em lote contra o ERP e restringir o reprocessamento a um papel operacional autenticado.

---

## REQ-STATE: transições válidas e inválidas

### REQ-STATE-01 [IMPLEMENTAR]
O sistema deve permitir somente as transições abaixo, definidas em uma única função de domínio:

| De | Para | Gatilho |
|---|---|---|
| `PENDING` | `PROCESSING` | claim do worker |
| `RETRY_SCHEDULED` | `PROCESSING` | claim do worker (`next_attempt_at` vencido) |
| `UNCERTAIN` | `PROCESSING` | claim para reconciliação |
| `PROCESSING` | `PROCESSING` | reclaim após lease vencido |
| `PROCESSING` | `SENT` | `SUCCESS` ou `lookup FOUND` |
| `PROCESSING` | `RETRY_SCHEDULED` | `TRANSIENT_ERROR` com tentativas restantes |
| `PROCESSING` | `FAILED` | `PERMANENT_ERROR` (`ERP_REJECTED`) ou transitório esgotado (`RETRIES_EXHAUSTED`) |
| `PROCESSING` | `UNCERTAIN` | `AMBIGUOUS{TIMEOUT}` na criação, ou consulta `UNKNOWN` |
| `PROCESSING` | `NEEDS_REVIEW` | ambíguo esgotado, `AMBIGUOUS{CONFLICT}` + `NOT_FOUND`, ou reclaim com tentativas esgotadas (feito dentro da transação do claim) |
| `FAILED` | `PENDING` | reprocess |
| `NEEDS_REVIEW` | `UNCERTAIN` | reprocess |

- Given cada par (de, para) da tabela, When validado, Then é aceito.

### REQ-STATE-02 [IMPLEMENTAR]
Quando for solicitada uma transição fora da tabela de REQ-STATE-01, o sistema deve rejeitá-la com erro de domínio `InvalidTransitionError`, sem alterar o banco.
- Given todos os pares (de, para) **não** listados (incluindo qualquer saída de `SENT`), When validados, Then todos são rejeitados.

### REQ-STATE-03 [IMPLEMENTAR]
O sistema deve aplicar toda transição no banco com `UPDATE ... WHERE id = $1 AND status = <de>` (mais `lease_token` quando vier do worker) e gravar o evento correspondente em `order_events` na **mesma transação**; se 0 linhas forem afetadas, nenhum evento de transição é gravado. A única exceção é o registro da chamada ao ERP com lease perdido (REQ-CONC-04), gravado com `to_status = NULL`.
- Given pedido em `SENT`, When o código tenta aplicar `FAILED -> PENDING`, Then 0 linhas afetadas, nenhum evento novo e o chamador recebe indicação de conflito.

### REQ-STATE-04 [IMPLEMENTAR]
O sistema deve tratar `SENT` como estado terminal: nenhum fluxo (worker ou API) o altera.
- Given pedido `SENT`, When `runOnce()` e reprocess são executados, Then o status continua `SENT` e o ERP não recebe chamadas.

---

## REQ-OBS: logs, eventos e dados sensíveis

### REQ-OBS-01 [IMPLEMENTAR]
O sistema deve emitir logs estruturados em JSON (pino) e incluir `correlationId` em todo log de requisição e `correlationId`, `orderId`, `attempt` e `status` em todo log do worker relacionado a um pedido.
- Given um fluxo completo (criação -> `SENT`), When os logs são capturados, Then todo log do worker sobre o pedido contém esses 4 campos.

### REQ-OBS-02 [IMPLEMENTAR]
Quando receber uma requisição, o sistema deve usar o header `X-Correlation-Id` se ele casar com `^[A-Za-z0-9-]{1,64}$`, ou gerar um UUID caso contrário; deve devolvê-lo no header de resposta, persisti-lo no pedido criado e propagá-lo aos logs e eventos do worker.
- Given `X-Correlation-Id: abc-123`, When `POST /orders` e o worker processa, Then a resposta tem o mesmo header e os eventos do pedido têm `correlation_id = abc-123`.
- Given header com caracteres inválidos, When a requisição chega, Then um UUID novo é usado.

### REQ-OBS-03 [IMPLEMENTAR]
O sistema deve registrar em `order_events` (somente inserções) uma linha por criação, claim, chamada ao ERP (criação ou consulta) e reprocessamento; a transição causada por cada fato fica em `from_status`/`to_status` da própria linha (quando não há transição, ambos ficam iguais). Tipos: `CREATED`, `ATTEMPT_STARTED`, `ERP_CREATE`, `ERP_LOOKUP`, `ATTEMPT_ABANDONED` (REQ-RETRY-05), `REPROCESS_REQUESTED`. Campos: `type`, `from_status`, `to_status`, `attempt`, `outcome`, `error_code`, `error_message`, `duration_ms` (chamadas ao ERP), `correlation_id` e `created_at`.
- Given cenário `processed_then_timeout` processado até `SENT`, When os eventos são lidos, Then aparecem, em ordem: `CREATED`, `ATTEMPT_STARTED (1)`, `ERP_CREATE (AMBIGUOUS/TIMEOUT)`, `ATTEMPT_STARTED (2)`, `ERP_LOOKUP (FOUND)`, com `duration_ms` nas chamadas ao ERP e transições coerentes.

### REQ-OBS-04 [IMPLEMENTAR]
O sistema deve guardar erros do ERP apenas como `error_code` (até 64 caracteres) e `error_message` (truncada em 200 caracteres), nunca o body bruto da resposta. Antes de gravar, os valores de `customer.document`, `customer.email` e `customer.name` do payload do pedido que aparecerem na mensagem são substituídos por `[REDACTED]` (o ERP pode ecoar dados do pedido no erro). A substituição vem antes do truncamento, para que um valor cortado ao meio também não vaze.
- Given `FakeErpClient` retornando mensagem de 1000 caracteres, When o erro é gravado, Then `error_message` tem no máximo 200 caracteres.
- Given pedido criado via `POST /orders` com `document`/`email` reconhecíveis e um ERP que devolve mensagem longa contendo esses valores (antes e depois do caractere 200), When o worker processa, Then o `error_message` em `order_events` (e em `orders.last_error_message`) tem no máximo 200 caracteres e não contém os valores.

### REQ-OBS-05 [IMPLEMENTAR]
O sistema nunca deve logar o payload do pedido nem dados pessoais: o body das requisições não é logado e o logger aplica `redact` (censura) a `customer`, `document`, `email`, `name`, `notes`, `payload`, `req.headers.authorization` e `req.headers.cookie`, em qualquer nível de aninhamento usado pelo código.
- Given payload com marcadores únicos (ex.: `document = "98765432100"`, `email = "marker@example.test"`), When o pedido é criado, processado em todos os cenários do fake e consultado, Then nenhum log capturado contém os marcadores.
- Given um log acidental do tipo `logger.info({ payload })`, When emitido, Then o valor aparece como `[REDACTED]`.

### REQ-OBS-06 [PROPOSTA PRODUÇÃO]
O sistema deveria expor métricas (pedidos por status, latência e taxa de erro do ERP, idade do pedido mais antigo em `UNCERTAIN`), tracing distribuído (OpenTelemetry, propagando `traceparent` ao ERP) e um trigger no banco impedindo `UPDATE`/`DELETE` em `order_events`.

---

## REQ-SEC: validação, limites e proteção de dados

### REQ-SEC-01 [IMPLEMENTAR]
Quando o corpo da requisição exceder 32 KB, o sistema deve responder `413` com `code: "PAYLOAD_TOO_LARGE"` sem processá-lo.
- Given body de 40 KB, When `POST /orders`, Then 413 e nada é persistido.

### REQ-SEC-02 [IMPLEMENTAR]
Quando `POST /orders` chegar com `Content-Type` diferente de `application/json`, o sistema deve responder `415` com `code: "UNSUPPORTED_MEDIA_TYPE"`.
- Given `Content-Type: text/plain`, When `POST /orders`, Then 415.

### REQ-SEC-03 [IMPLEMENTAR]
O sistema deve validar toda entrada externa com Zod em modo estrito (campos desconhecidos rejeitados, limites de tamanho e de faixa numérica em todos os campos) e executar SQL exclusivamente com parâmetros.
- Coberto pelos critérios de REQ-API-02 e REQ-API-03; revisão de código garante ausência de SQL concatenado.

### REQ-SEC-04 [IMPLEMENTAR]
O sistema deve ler configuração apenas de variáveis de ambiente validadas na inicialização; o repositório contém somente `.env.example` com valores fictícios e nenhum segredo.
- Given variável obrigatória ausente ou inválida, When o processo inicia, Then falha com mensagem que cita o nome da variável, mas não seu valor.

### REQ-SEC-05 [PROPOSTA PRODUÇÃO]
O sistema deveria ter autenticação (API key por cliente ou OAuth2 client credentials) e autorização (reprocess só para papel operacional), rate limiting por cliente, TLS de ponta a ponta, usuário de banco com privilégio mínimo, criptografia/mascaramento dos dados pessoais em repouso, política de retenção (LGPD) e varredura de dependências no CI.

---

## Não-objetivos

- Interface web, autenticação/autorização, multi-tenant.
- ERP real ou cliente HTTP real (só o contrato, a classificação e o fake).
- Atualização, cancelamento ou listagem de pedidos.
- Garantia *exactly-once* no ERP (impossível sem cooperação do ERP; ver Premissas).
- Redis, fila/mensageria externa, circuit breaker, ORM.
- Stack de métricas, tracing e alertas (apenas proposta).
- Notificação ao cliente (webhook) sobre mudança de status: o cliente consulta `GET /orders/:id`.

## Premissas

- **P-01 (crítica)**: o ERP real aceita uma referência externa (o `order.id`) na criação e permite consultar por ela (`lookupByReference`), **ou** aceita uma idempotency key equivalente. Sem isso, um timeout só pode ser resolvido por conciliação manual (`NEEDS_REVIEW`).
- **P-02 (risco aceito)**: `5xx`, `408`, `429` e conexão recusada/reset são **assumidos como "não processado"** pelo ERP, e por isso o reenvio acontece sem consulta prévia (Q-04). Se o ERP real puder efetivar o pedido e ainda assim responder `5xx`, esse reenvio pode duplicar, a menos que o ERP deduplique pela referência (P-01). Aceitamos esse risco para não pagar uma consulta extra em todo retry; a mitigação é a referência estável enviada em toda chamada. Para eliminá-lo, basta passar a consultar antes de todo reenvio. O mesmo risco aceito vale para respostas `1xx`/`3xx` na criação, que estão fora do contrato do ERP e são classificadas como `TRANSIENT_ERROR`: em especial, um `3xx` em resposta a um `POST` pode significar que o ERP processou e redirecionou. Ainda assim o reenvio fica limitado por `MAX_ATTEMPTS` (termina em `FAILED`/`RETRIES_EXHAUSTED`) e carrega sempre a mesma referência.
- **P-03**: a consulta por referência é consistente logo após a criação (*read-after-write*). Se o ERP tiver consistência eventual, um `NOT_FOUND` precoce pode levar a reenvio; mitigado pelo atraso mínimo da reconciliação e, de forma definitiva, pela deduplicação no ERP.
- **P-04**: todas as comparações de tempo (lease, agendamento) usam `now()` do Postgres, evitando divergência de relógio entre instâncias.
- **P-05**: o cliente gera uma `Idempotency-Key` por intenção de negócio (ex.: UUID por checkout) e a reutiliza ao repetir a mesma requisição.
- **P-06**: volume moderado (dezenas de pedidos por segundo); polling no Postgres é suficiente.
- **P-07**: um pedido da API corresponde a exatamente um pedido no ERP.

## Perguntas em aberto

Nenhuma no momento. Histórico das decisões da Fase 1:

| Q | Decisão |
|---|---|
| Q-01 | Formato aprovado; dinheiro em centavos; `document` só por formato. |
| Q-02 | `200` + `Idempotent-Replayed: true`, corpo com o estado atual (REQ-IDEM-02). |
| Q-03 | Lease vencido = ambíguo; evento `ATTEMPT_STARTED` gravado antes da chamada ao ERP (REQ-ERP-01, REQ-CONC-05). |
| Q-04 | Consulta só nos casos ambíguos; P-02 registrada como risco aceito. |
| Q-05 | Transitório esgotado e permanente -> `FAILED`, distinguidos por `RETRIES_EXHAUSTED` / `ERP_REJECTED`; ambíguo esgotado -> `NEEDS_REVIEW`. |
| Q-06 | Reprocess só de `FAILED`/`NEEDS_REVIEW`; idempotente; `reason` opcional; zera tentativas; preserva eventos (REQ-RETRY-07/08). |
| Q-07 | O worker reconcilia `UNCERTAIN` automaticamente. |
| Q-08 | `GET /orders/:id` não devolve o payload. |
| Q-09 | `409` = `AMBIGUOUS{CONFLICT}`; cenários `conflict_found`/`conflict_not_found` no fake; `CONFLICT` + `NOT_FOUND` -> `NEEDS_REVIEW` imediato (REQ-ERP-11). |
| Gate F2 (1) | Reprocess decide por `UPDATE` atômico (`WHERE status IN (...)`); nunca SELECT + UPDATE; teste com N concorrentes. |
| Gate F2 (2) | Resultado ambíguo renomeado para `AMBIGUOUS{cause: TIMEOUT \| CONFLICT}`; consulta inconclusiva = `UNKNOWN`. |
| Gate F2 (3) | `attempts` conta claims; `attempts > MAX_ATTEMPTS` esperado no reclaim esgotado, que vai a `NEEDS_REVIEW` sem tentativa nem ERP. |
| Q-10 | docker compose com banco `orders_test`, `TRUNCATE` entre testes, nunca o banco de dev. |
| Q-11 | Graceful shutdown entra no scaffold, sem requisito próprio. |
| Q-12 | Enunciado renomeado para `docs/desafio.pdf`. |

<details><summary>Texto original das perguntas</summary>

- **Q-01**: O formato do pedido proposto acima atende? (Recomendo manter: tem dados pessoais suficientes para demonstrar o `redact`.)
- **Q-02**: Repetição com mesma chave e mesmo payload: responder `200` + `Idempotent-Replayed: true` (recomendado, distingue criação de repetição) ou `202` idêntico ao original?
- **Q-03**: Lease vencido em `PROCESSING` deve ser tratado como **ambíguo** (consulta antes de reenviar, REQ-CONC-05/REQ-ERP-06)? É uma extensão da decisão "consultar antes de reenviar UNCERTAIN": o worker pode ter caído depois de o ERP receber o pedido. Recomendo sim.
- **Q-04**: Consultar o ERP antes de **todo** reenvio (inclusive após `5xx`), eliminando a premissa P-02 ao custo de uma chamada extra por retry? Recomendo manter a decisão original (só em casos ambíguos) e registrar P-02 como risco.
- **Q-05**: Esgotamento de tentativas: transitório -> `FAILED` (sabemos que não chegou ao ERP) e ambíguo -> `NEEDS_REVIEW` (pode ter chegado). Confirma a distinção?
- **Q-06**: Reprocess permitido só a partir de `FAILED` e `NEEDS_REVIEW` (REQ-RETRY-07/08)? `UNCERTAIN` já é reconciliado automaticamente pelo worker.
- **Q-07**: O worker deve reconciliar `UNCERTAIN` **automaticamente** (com backoff) em vez de esperar reprocess manual? Recomendo automático.
- **Q-08**: `GET /orders/:id` não devolve o payload (evita expor dados pessoais sem autenticação). De acordo?
- **Q-09**: `409` do ERP ("referência já existe") tratado como ambíguo, resolvido via consulta (que retornará `FOUND` -> `SENT`). Isso evita um quinto tipo de resultado no contrato. De acordo?
- **Q-10**: Testes de integração com **docker compose** (um banco `orders_test` separado, recriado por suíte) em vez de Testcontainers. Recomendo docker compose: mais simples e rápido. De acordo?
- **Q-11**: Graceful shutdown simples (parar de reivindicar, aguardar tentativa em andamento, fechar Fastify e pool) entra como parte do scaffold, sem requisito próprio? Recomendo sim, coberto implicitamente pelo lease.
- **Q-12**: O enunciado está em `docs/Desafio Técnico Dev Senior - Grupo Morada..pdf` (não em `docs/desafio.pdf`) e pula da seção 4 para a 6. Devo renomear o arquivo para `docs/desafio.pdf`? A seção 5 ausente tem algum conteúdo que eu deva considerar?

</details>
