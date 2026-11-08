# Handle succ.ai API errors

An uncertain request can still be charged. This covers a timeout, an empty answer, a cut-off stream, and a 502 or 503 after the request was sent. Don't resend it automatically. Using a new `Idempotency-Key` does not make a resend safe: it creates a second paid request. Start from the user's usage history, not from another request.

## 1. Collect a clean record

Record:
- the time in UTC
- the model ID and endpoint
- the HTTP status and error code
- the `X-Request-ID` response header, if present

Keep the `Idempotency-Key` privately with the operation. Never collect API keys, `Authorization` headers, cookies, recovery codes, prompts, outputs, tool arguments or raw configuration, and don't put them in logs or support messages.

The error body looks like this:
- **Chat Completions and Responses:** `{"error": {"code", "type", "message"}}`
- **Messages:** `{"type": "error", "error": {"type", "message"}, "code"}`

Read the `code` as well as the status.

## 2. Look it up

| Status and code | Meaning | What to do |
| --- | --- | --- |
| `400`, `413`, `415` | An invalid field, a body over 32 MiB (the original or the forwarded one), or an unsupported encoding. Compressed bodies are rejected. | Fix the request using the protocol guide. Don't resend the same body. |
| `401`, `403` | A wrong, disabled or unauthorized key | The client must send the full application key, not its public ID, a recovery code or a session cookie. The user checks the key and account privately at https://succ.ai/dashboard/keys. |
| `402` | Not enough eligible credit, held credit, the key's budget, or no permission to spend funding credit. Promotional credit can be limited to certain models. | Check https://succ.ai/dashboard and the key settings. Don't create a payment or raise a budget yourself. |
| `404` `model_not_found` | The model is not offered, or not allowed for this key | Check the exact ID in `GET /v1/models`. Don't rename another model to the requested ID. |
| `404` on the URL | Wrong base URL, for example `/v1/v1/messages` | Anthropic SDKs and Claude tools use `https://api.succ.ai` without `/v1`. |
| `409` `duplicate_request` | The same `Idempotency-Key` with the same request within 24 hours. The original was accepted, and its result is not stored. | Find it at https://succ.ai/dashboard/usage. Don't create a new idempotency key or API key to get around it. |
| `409` `idempotency_conflict` | The same `Idempotency-Key` was used for a different request | Find the original operation first, then fix the client's request tracking. |
| `429` or `503` `payload_capacity` | Request-body capacity is busy. Nothing reached a model and nothing was billed. Requests are not queued. | Wait for `Retry-After` and reduce concurrent or large requests. Ask before resending. |
| `429`, any other code | A rate limit on the account or the key | Respect `Retry-After` and lower the rate or concurrency. No retry loops. |
| `503` `route_unavailable` | No compatible route is available for this model and protocol right now | Check the protocol's flag in `GET /api/models`. Don't silently change the model, the protocol or the ZDR setting. |
| `502`, any other `503`, a timeout or a broken stream | The outcome and the cost are unknown | Go to section 3. |

## 3. Reconcile an uncertain request

1. Stop automatic retries in the client. Keep the model, request body and `Idempotency-Key` unchanged.
2. Check the request at https://succ.ai/dashboard/usage and held credit at https://succ.ai/dashboard. "Pending" means neither a final charge nor a free failure.
3. If it is still unclear, wait for settlement or contact support at the address in https://succ.ai/terms. Send the time, request ID, endpoint, model, status and code. Never send the key or the prompt.
4. Tell the user what is known and what isn't. Get their approval before any new paid request.

**Idempotency.** One `Idempotency-Key` identifies one logical generation. Requests are deduplicated across the account for 24 hours, and results are not stored, so a duplicate cannot replay the answer. After 24 hours, the same key makes a new, charged request.

## 4. Streams and tools

- **A 200 status is not success.** HTTP 200 at the start of a stream proves nothing until the stream finishes.
- **How each stream finishes:**
  - Chat: a choice with `finish_reason`, then `data: [DONE]`
  - Messages: `message_stop`
  - Responses: `response.completed`. Also handle `response.failed`, `response.incomplete` and error events.
- **Protocol guides:** https://succ.ai/docs/openai, https://succ.ai/docs/messages and https://succ.ai/docs/responses.
- **Tool calls.** Assemble tool-call arguments completely, validate them and check permissions before running anything.
- **Side effects.** The `Idempotency-Key` does not cover tool side effects such as file writes, payments or commands. Resending a model request can repeat them, so track those actions separately.

## 5. Report

Report:
- the clean facts
- the user's usage status
- the fix or the support path
- whether any new paid request was approved

Don't call a failure free or resolved without evidence.
