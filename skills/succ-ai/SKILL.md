---
name: succ-ai
description: "Connect coding agents to succ.ai, choose succ.ai models and handle succ.ai API errors without paying twice. Use when the user mentions succ.ai, succ or api.succ.ai; wants Claude Code, Claude Desktop, Codex, OpenCode, Pi or Oh My Pi to use a succ.ai key; compares succ.ai models, context, reasoning efforts or prices; or gets a succ.ai 401, 402, 404, 409, 429 or 503 error, a timeout or a cut-off stream."
license: MIT
---

# succ.ai

succ.ai serves selected third-party models through three compatible APIs at `https://api.succ.ai`: OpenAI Chat Completions, stateless OpenAI Responses and Anthropic Messages. Accounts hold prepaid USD credit. Every account starts with zero-data-retention (ZDR) routes only.

## Ground rules

These apply to every task below.

1. **No paid request without a yes for that request.** `POST /v1/chat/completions`, `/v1/messages` and `/v1/responses` cost money. Never send one to test a setup, compare models or retry, unless the user approved that exact request. Model lists are free.
2. **The API key never enters this conversation.** Don't ask for it, print it, or put it in a command, URL, log or anything you show. The user types it into the setup script or into the tool's own masked prompt.
3. **Keep what the user chose.** Leave their tool, model, reasoning effort, request budgets, default model, other providers, logins and permissions as they are. The same goes for the account's ZDR, route-preference and service-tier settings. Never switch model, protocol or privacy setting to get around an error or a price. Explain the trade-off and let the user decide.
4. **Use live data, not memory.** Read model IDs, capacities, efforts and availability from the live catalog. A model's name or an old list is not evidence.
5. **Say what you checked.** A model list proves that a configuration loads. It does not prove that inference, streaming, tools or the balance work.

## Pick the task

| The user wants to | Read |
| --- | --- |
| Connect Claude Code, Claude Desktop, Codex, OpenCode, Pi or Oh My Pi | [references/setup.md](references/setup.md) |
| Choose or compare models | [references/models.md](references/models.md) |
| Understand an error, a timeout or a cut-off stream | [references/errors.md](references/errors.md) |

## The setup script

`scripts/succ-setup.mjs` needs Node.js 18 or later and has no dependencies. It reads the catalogs, takes the key in a hidden prompt and lets the user pick tools and models. It then shows a plan and writes only after confirmation, with backups and owner-only files. It sends only GET requests and never contacts a model.

`<skill-dir>` below means the folder that contains this file.

- **You may run** `node <skill-dir>/scripts/succ-setup.mjs models --json [--protocol chat|messages|responses]`. It lists the public catalog and needs no key.
- **The user runs** `node <skill-dir>/scripts/succ-setup.mjs setup` in their own terminal. It needs a keyboard, so give them the command with the absolute path and don't run it yourself. `--dry-run` shows what their key can use and what would change, without writing anything.
- **No local copy?** If you loaded this skill from a URL, the user can run the same script with `npx -y github:vinaes/succ-ai-skill setup`.

## Quick reference

| API | Endpoint | Catalog flag | SDK base URL | Authentication |
| --- | --- | --- | --- | --- |
| Chat Completions | `POST https://api.succ.ai/v1/chat/completions` | `available` | `https://api.succ.ai/v1` | `Authorization: Bearer <key>` |
| Responses | `POST https://api.succ.ai/v1/responses` | `responses_available` | `https://api.succ.ai/v1` | Bearer. Requires `store:false` and the full input history. |
| Messages | `POST https://api.succ.ai/v1/messages` | `messages_available` | `https://api.succ.ai`, without `/v1` | `x-api-key` plus `anthropic-version: 2023-06-01`, or Bearer |

- **Catalogs:**
  - Public: `GET https://api.succ.ai/api/models`, no key.
  - Allowed for a key: `GET https://api.succ.ai/v1/models`, needs the key.
  - Names and descriptions: `GET https://succ.ai/api/public-catalog`. This one is served by succ.ai, not api.succ.ai.
  - Prices: `GET https://api.succ.ai/api/model-pricing`.
- **Not available on any model:** audio or video input, PDF or binary uploads, provider-hosted tools (web search, code execution, computer use), stored Responses conversations and explicit cache-creation endpoints. The size limit is 32 MiB per JSON body, and compressed bodies are rejected.
- **Account pages:**
  - API keys: https://succ.ai/dashboard/keys
  - Credit and holds: https://succ.ai/dashboard
  - Usage: https://succ.ai/dashboard/usage
  - Privacy and routing: https://succ.ai/dashboard/security
- **More:**
  - Client guide: https://succ.ai/agent-setup.md
  - API docs: https://succ.ai/docs
  - Accounts and keys: https://succ.ai/auth.md
  - Terms: https://succ.ai/terms
