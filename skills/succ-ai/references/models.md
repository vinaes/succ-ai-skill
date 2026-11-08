# Choose a succ.ai model

## 1. Requirements

Find out:
- the task
- the tool and its protocol
- typical input size and the output budget
- whether it needs tools, JSON output or images
- whether reasoning control matters

If the user already picked a model, keep it unless it cannot do the job. In that case, explain why and offer alternatives. Ask about a missing requirement only when the answer changes the choice.

## 2. Read the live catalog

- **Public catalog.** Run `node <skill-dir>/scripts/succ-setup.mjs models --json`, adding `--protocol chat|messages|responses` if needed, or call `GET https://api.succ.ai/api/models`.
- **Descriptions.** Use https://succ.ai/models or `GET https://succ.ai/api/public-catalog`, merging by exact `id`. Being published there does not make a model available.
- **What the user's key can use.** The user runs `setup --dry-run`, or calls the key-filtered `GET https://api.succ.ai/v1/models`. Handle the key privately, as described in [setup.md](setup.md). A missing ID usually means the key's allowed-models list excludes it.
- **Disagreements.** If the public and key catalogs disagree about a model, fetch both once more. If they still differ, report it. Never probe with a generation.

## 3. Compare

| Field | What it tells you |
| --- | --- |
| `available`, `messages_available`, `responses_available` | Usable now through Chat, Messages or Responses. Check each protocol separately. A true flag does not guarantee credit or capacity when the request arrives. |
| `context_window`, `max_output_tokens` | Ceilings, not budgets. Input, output and reasoning share the window, so both maxima can't always be used together. When the output budget is omitted, the default is 4096, not the maximum. |
| `thinking`, `reasoning_efforts` | `thinking:true` means the model reasons. Only `reasoning_efforts` lists the effort values it accepts. Empty means send no effort field. The wire fields are Chat `reasoning_effort`, Responses `reasoning.effort` and Messages `output_config.effort`. In Messages, `none` becomes `thinking:{type:"disabled"}`. |
| `vision`, `max_images` | Image input means JPEG, PNG, GIF or WebP, by public HTTPS URL or base64. A positive `max_images` caps images across the whole history. `0` on a vision model means no published limit, not unlimited. |
| `tools`, `parallel_tool_calls`, `structured_output` | Tools run on the client. Parallel calls are allowed, not guaranteed. JSON schema output needs `structured_output:true`. |
| `supported_service_tiers` | `flex` is allowed only when listed. It is best-effort, with no promised discount or speed. |

## 4. Cost, without a paid probe

- **Where prices come from.** https://succ.ai/pricing or `GET https://api.succ.ai/api/model-pricing`, in USD.
- **What a price means.**
  - Listed prices are approximate minimums across eligible routes; the route that serves the request sets the final charge.
  - Unknown pricing does not mean free.
  - An image request can reserve credit for the full remaining context.
  - Promotional credit can be limited to certain models.
- **What the user can spend.** Their credit and holds are at https://succ.ai/dashboard, and the key's budget at https://succ.ai/dashboard/keys. Don't request funding or change key permissions.
- **No cheaper-by-stealth.** Don't lower the cost by relaxing ZDR, switching protocol or service tier, or changing the route preference. Describe the trade-off. The account holder decides at https://succ.ai/dashboard/security after reading https://succ.ai/privacy. Routes outside ZDR may retain prompts or train on them.

## 5. Answer

Give:
- the exact model ID and protocol
- why it fits
- its capacity compared with the planned budget
- the effort choice
- where the price came from
- what you excluded, and why

Make clear that the recommendation comes from metadata, not a test run. Don't run paid comparisons or retry loops unless the user approves each request.
