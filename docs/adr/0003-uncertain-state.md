# ADR-0003: Estado UNCERTAIN em vez de retry cego

**Contexto.** Um timeout (ou um crash no meio da chamada, ou um `409`: resultado `AMBIGUOUS` no contrato) não diz se o ERP criou o pedido. Reenviar às cegas é a principal fonte de duplicidade. Desistir pode perder o pedido.

**Decisão.** Resultados ambíguos levam ao estado `UNCERTAIN`. A próxima tentativa **consulta** o ERP pela referência estável (`order.id`) antes de qualquer reenvio: `FOUND` → `SENT`; `NOT_FOUND` → reenvia; consulta inconclusiva → continua `UNCERTAIN`, com backoff. Esgotadas as tentativas, o pedido vai para `NEEDS_REVIEW` (nunca `FAILED`, porque ele pode existir no ERP). Lease vencido recebe o mesmo tratamento.

**Consequências.**
- (+) Na aplicação, a duplicidade só pode surgir do caso `NOT_FOUND` falso (consistência eventual, P-03) e de `5xx` que na verdade foi processado (P-02, risco aceito).
- (+) Cada estado diz algo útil para a operação: `UNCERTAIN` se resolve sozinho, `NEEDS_REVIEW` precisa de pessoa.
- (−) Depende da premissa P-01 (o ERP precisa permitir consulta por referência). Sem ela, todo timeout vira conciliação manual.
- (−) Há uma chamada extra ao ERP por reconciliação e mais estados para explicar.

**Alternativas descartadas.** Retry cego (duplica). Tratar timeout como `FAILED` (perde ou duplica no reprocessamento manual). Consultar antes de **todo** retry (custo extra; reavaliável, ver P-02).
