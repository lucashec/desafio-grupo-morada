# ADR-0001: Postgres como fila

**Contexto.** Os pedidos precisam ser processados de forma assíncrona, com retry agendado e recuperação após crash. O estado do pedido já precisa ficar no Postgres por causa da rastreabilidade. O volume esperado é moderado (P-06).

**Decisão.** A própria tabela `orders` é a fila: um worker no mesmo processo faz polling e reivindica pedidos com `SELECT ... FOR UPDATE SKIP LOCKED`, e um lease (`locked_until` + `lease_token`) protege contra crash. Os índices parciais cobrem só os pedidos pendentes e os que estão em voo.

**Consequências.**
- (+) Estado e "mensagem" mudam na mesma transação: não existe dual write (gravar no banco e publicar na fila) nem outbox.
- (+) Um componente a menos para operar. Os testes rodam com um único container.
- (−) O polling gera latência de até `WORKER_POLL_INTERVAL_MS` e carga constante no banco. A vazão é limitada pelo Postgres.
- (−) O lease precisa ser calibrado contra os timeouts do ERP (REQ-CONC-06).

**Alternativas descartadas.** RabbitMQ/SQS (exigem outbox para não perder ou duplicar mensagem entre banco e fila). Redis/BullMQ (segunda fonte de verdade). `LISTEN/NOTIFY` (otimização de latência; fica como proposta).
