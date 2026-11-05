# ADR-0004: Idempotência garantida pelo banco, não pela aplicação

**Contexto.** O cliente pode repetir `POST /orders`, inclusive em paralelo (retry de rede, duplo clique, várias instâncias da API). Um "SELECT, se não existir INSERT" na aplicação tem uma janela de corrida, e um lock em memória não vale entre instâncias.

**Decisão.** `UNIQUE(idempotency_key)` + `INSERT ... ON CONFLICT DO NOTHING RETURNING`, com o evento `CREATED` na mesma instrução. Se nada retornar, lê o registro existente e compara o `request_hash` (SHA-256 do JSON canônico): igual → `200` replay; diferente → `422`.

**Consequências.**
- (+) Correto por construção, para qualquer número de instâncias. Sem lock explícito nem retry de serialização.
- (+) O `request_hash` detecta reuso indevido da chave sem guardar uma segunda cópia do payload.
- (−) As chaves ficam guardadas para sempre (expiração é proposta, REQ-IDEM-05), e o escopo é global, não por cliente.
- (−) A deduplicação é **por chave**, não por conteúdo: o mesmo pedido com chave nova é um pedido novo (P-05).

**Alternativas descartadas.** Checagem na aplicação (corrida). Advisory lock por chave (mais código, mesmo resultado). Redis `SETNX` (segunda fonte de verdade e sem atomicidade com a gravação do pedido). `SERIALIZABLE` (exige retry de transação).
