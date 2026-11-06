# Integração de Pedidos com ERP — Case Grupo Morada

API para recebimento de pedidos de venda e encaminhamento a um ERP externo instável. A solução recebe o pedido, garante que a mesma solicitação nunca gere dois pedidos (idempotência no banco), envia ao ERP de forma assíncrona com retry e reconciliação, e mantém uma trilha completa do que aconteceu com cada pedido, inclusive quando o ERP processa o pedido e a resposta se perde (timeout).

## Arquitetura da solução

```
┌─────────────┐ HTTP  ┌──────────────────────────┐       ┌──────────────────┐
│ Cliente     ├──────►│ Fastify API              ├──────►│ PostgreSQL 16    │
│ (POST,      │       │ /orders, /orders/:id,    │       │ orders           │
│ GET,        │◄──────┤ /orders/:id/reprocess,   │       │ order_events     │
│ reprocess)  │ 202   │ /health  (porta 3000)    │       │ (fila + trilha)  │
└─────────────┘       └──────────────────────────┘       └────────▲─────────┘
                                                                  │ claim
                                                                  │ SKIP LOCKED
                                                                  │ + lease
                                                         ┌────────┴─────────┐
                                                         │ Worker           │
                                                         │ (mesmo processo, │
                                                         │ retry, backoff,  │
                                                         │ reconciliação)   │
                                                         └────────┬─────────┘
                                                                  │ createOrder /
                                                                  │ lookupByReference
                                                         ┌────────▼─────────┐
                                                         │ ERP (simulado)   │
                                                         │ FakeErpClient    │
                                                         │ com cenários de  │
                                                         │ falha            │
                                                         └──────────────────┘
```

O fluxo funcional é:
1. **Recebimento** — `POST /orders` valida o corpo (Zod estrito) e exige o header `Idempotency-Key`. O pedido e o evento `CREATED` são gravados numa única instrução (`INSERT ... ON CONFLICT DO NOTHING`), e a API responde `202` sem chamar o ERP.
2. **Idempotência** — repetir a mesma chave com o mesmo payload devolve `200` + `Idempotent-Replayed: true` com o estado atual; com payload diferente, `422`. A unicidade é garantida pelo banco, inclusive com requisições simultâneas.
3. **Envio ao ERP** — o worker reivindica um pedido com `FOR UPDATE SKIP LOCKED` e um lease, e só depois do commit chama o ERP, enviando o `id` do pedido como referência estável. Erros transitórios (5xx, 408, 429, conexão) geram retry com backoff exponencial e jitter; erros de negócio (4xx) marcam `FAILED`.
4. **Resultado ambíguo** — em timeout, conflito (409) ou lease vencido (worker caiu), o pedido vai para `UNCERTAIN` e a próxima tentativa **consulta o ERP pela referência antes** de qualquer reenvio. Se o ERP não responder de forma conclusiva até o limite de tentativas, o pedido vai para `NEEDS_REVIEW`.
5. **Rastreabilidade** — cada claim, chamada ao ERP (com duração), transição de status e reprocessamento vira uma linha em `order_events` com `correlation_id`. Os logs são estruturados (pino) e não contêm dados pessoais.
6. **Reprocessamento** — pedidos em `FAILED` ou `NEEDS_REVIEW` podem ser reprocessados manualmente; a decisão é um único `UPDATE` atômico, então chamadas concorrentes geram um único reprocessamento.

Estados do pedido: `PENDING → PROCESSING → SENT | RETRY_SCHEDULED | FAILED | UNCERTAIN | NEEDS_REVIEW`. `SENT` é terminal.

## Arquitetura e decisões técnicas

A solução roda em um único processo Node.js com TypeScript, que contém a API HTTP e um worker assíncrono, e o PostgreSQL faz três papéis: fonte da verdade, fila de processamento e trilha de auditoria. A principal decisão foi desacoplar o recebimento do pedido do envio ao ERP. A API apenas registra o pedido e responde imediatamente, e o worker cuida da integração em segundo plano, então a lentidão ou queda do ERP nunca bloqueia o cliente. Usar o próprio banco como fila evita um broker adicional e mantém pedido, estado e histórico sempre consistentes.

## Idempotência, concorrência e tratamento de falhas

A idempotência é garantida pelo banco de dados, e não pela aplicação. Cada pedido carrega uma chave única fornecida pelo cliente, e repetições com a mesma chave devolvem o pedido original em vez de criar outro. Na concorrência, apenas um worker por vez assume cada pedido, por meio de um lease temporário, e um worker que perdeu o lease não consegue sobrescrever o resultado de outro. Falhas transitórias do ERP são repetidas com intervalos crescentes, e erros de negócio encerram o pedido. Quando o resultado é ambíguo, como num timeout em que o ERP pode ter processado o pedido, o sistema nunca reenvia às cegas: consulta o ERP antes de tentar de novo e, sem resposta conclusiva, encaminha o pedido para revisão manual.

## O que foi implementado e o que ficou como proposta

Foram implementados o recebimento idempotente de pedidos, a consulta de status com histórico completo, o reprocessamento manual, o worker com retry e reconciliação, os logs estruturados sem dados pessoais e uma suíte de testes contra um banco real, cobrindo os cenários de concorrência e de falha. O ERP é simulado, mas reproduz sucesso, erros transitórios e permanentes, timeout e pedido processado com resposta perdida. Ficaram como proposta para produção a integração com um ERP real via HTTP, autenticação e controle de acesso, expiração das chaves de idempotência, métricas, alertas e rastreamento distribuído, além de criptografia e política de retenção dos dados pessoais.

## Estrutura do repositório

```
.
├── src/
│   ├── domain/         # Schema do pedido, máquina de estados, backoff, hash da requisição, limpeza de mensagens
│   ├── http/           # Rotas (orders, health), correlation id e formato padrão de erro
│   ├── infra/
│   │   ├── db/         # Pool, migrations e todo o SQL do sistema (orders.repo.ts)
│   │   └── erp/        # Contrato do ERP, classificação de respostas, timeout e FakeErpClient
│   ├── worker/         # Loop do worker e decisão de cada tentativa
│   ├── app.ts          # Montagem do Fastify
│   ├── config.ts       # Variáveis de ambiente validadas com Zod
│   ├── logger.ts       # pino + redact
│   └── server.ts       # Sobe API + worker, graceful shutdown
├── test/
│   ├── unit/           # Testes de funções puras
│   ├── integration/    # Testes contra Postgres real (API, worker, concorrência, logs)
│   └── helpers/        # Banco de teste, fixtures, captura de logs
├── docs/
│   ├── specs/          # Requisitos, plano, tarefas e matriz de rastreabilidade
│   ├── adr/            # Decisões de arquitetura
│   └── desafio.pdf     # Enunciado
├── docker/initdb/      # Cria o banco de testes (orders_test)
├── scripts/            # check-traceability.mjs
├── docker-compose.yml
├── package.json
└── .env.example
```

## Configuração do ambiente

Pré-requisitos: Node.js ≥ 22 e Docker (Compose v2).

Instale as dependências e copie o arquivo de variáveis de ambiente de exemplo (os valores já funcionam com o `docker-compose.yml` e são fictícios):

```bash
npm ci
cp .env.example .env
```

Principais variáveis (ver `.env.example` para a lista completa):

| Variável | Descrição | Padrão |
|---|---|---|
| `DATABASE_URL` | Conexão com o banco de desenvolvimento | `postgres://orders:orders@localhost:5432/orders_dev` |
| `TEST_DATABASE_URL` | Banco usado pela suíte de testes (nome precisa terminar em `_test`) | `postgres://orders:orders@localhost:5432/orders_test` |
| `PORT` | Porta da API | `3000` |
| `LOG_LEVEL` | Nível de log do pino | `info` |
| `MAX_ATTEMPTS` | Limite de tentativas por pedido | `5` |
| `RETRY_BASE_DELAY_MS` / `RETRY_MAX_DELAY_MS` | Base e teto do backoff exponencial | `1000` / `60000` |
| `ERP_TIMEOUT_MS` / `ERP_LOOKUP_TIMEOUT_MS` | Timeout da criação e da consulta no ERP | `5000` / `3000` |
| `LEASE_MS` | Duração do lease do worker (deve ser maior que a soma dos timeouts + 5000) | `30000` |
| `WORKER_POLL_INTERVAL_MS` | Espera do worker quando não há pedidos | `1000` |
| `WORKER_BATCH_SIZE` | Pedidos processados por ciclo | `10` |
| `WORKER_ENABLED` | Liga ou desliga o worker no processo | `true` |

## Subindo a aplicação

```bash
docker compose up -d --wait
npm run migrate
npm run dev
```

Após subir, a API fica disponível em **http://localhost:3000**, com o worker rodando no mesmo processo.

## Rodando testes

```bash
npm test
```

Verificações adicionais:

```bash
npm run test:stress
npm run typecheck && npm run lint
npm run check:trace
```

`test:stress` roda os testes de concorrência 5 vezes seguidas; `check:trace` confere que todo requisito tem ao menos um teste e que `docs/specs/traceability.md` está atualizado.

## Uso da aplicação

Criar um pedido:

```bash
curl -i -X POST http://localhost:3000/orders \
  -H 'content-type: application/json' -H 'idempotency-key: checkout-123' \
  -d '{"customer":{"name":"Maria Teste","document":"12345678901","email":"maria@example.test"},"items":[{"sku":"SKU-001","quantity":2,"unitPriceCents":1990}]}'
```

Com a API é possível:
- Criar pedidos de forma idempotente — repetir o mesmo comando devolve o mesmo pedido, sem duplicar;
- Consultar o status de um pedido, o número de tentativas, o último erro e a trilha completa de eventos;
- Reprocessar pedidos que falharam ou que precisam de revisão manual, informando um motivo opcional;
- Verificar a saúde da aplicação e do banco.

## Principais endpoints da API

Base: `http://localhost:3000`

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/orders` | Cria um pedido (header `Idempotency-Key` obrigatório); responde `202`, ou `200` em repetição |
| `GET` | `/orders/{id}` | Retorna status, tentativas, último erro e histórico de eventos (sem o payload do pedido) |
| `POST` | `/orders/{id}/reprocess` | Reprocessa um pedido em `FAILED` ou `NEEDS_REVIEW` (`reason` opcional); `409` nos demais status |
| `GET` | `/health` | Verifica a aplicação e a conexão com o banco |
