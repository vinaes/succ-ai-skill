# Connect a tool to succ.ai

## 1. Confirm the request

- **Which tools.** The supported tools are Claude Code (the `claude` terminal client), Claude Desktop, Codex, OpenCode, Pi and Oh My Pi. Configure only the ones the user named.
- **A key.** The user needs a succ.ai application API key.
  - If they have no account, they register at https://succ.ai/register. No email is needed. They must save the recovery code privately.
  - They create the key at https://succ.ai/dashboard/keys and choose its allowed models and budget there.
  - Registration and verification are human steps. There is no signup API and no OAuth.
- **A missing tool.** Name what is missing and ask before installing anything.

Anthropic does not support routing Claude Code or Claude Desktop to non-Claude models. This is a third-party gateway route. succ model IDs are succ's own, not Claude models.

## 2. Run the setup script (preferred)

Give the user this command, with the absolute path filled in:

```
node "<skill-dir>/scripts/succ-setup.mjs" setup
```

They run it in their own terminal: PowerShell or Windows Terminal on Windows, any terminal on macOS or Linux. Git Bash/mintty is not interactive for Node. The script:

1. Detects the installed tools.
2. Reads the public catalog, then checks the key with a free `GET /v1/models`.
3. Lets the user pick models for each tool. Every eligible model is preselected.
4. Shows a plan of every file it will create or update.
5. Writes only after the user confirms, backing up each changed file first. Files that hold the key are readable only by their owner.
6. Optionally runs read-only checks that list the configured models.

| Tool | What it writes | Where the key goes | Start command it prints |
| --- | --- | --- | --- |
| Claude Code | Default: a launch profile `~/.claude/succ.settings.json`, which leaves normal Claude Code untouched. Optional: env and model picker entries in `~/.claude/settings.json` | that file | `claude --settings <file> --model <id>` |
| Codex | `[model_providers.succ]` in `~/.codex/config.toml`, plus the catalog `~/.codex/succ-models.json` | `config.toml` | `codex -c model_provider=succ -c model_catalog_json=<file> -c web_search=disabled --model <id>` |
| OpenCode | `provider.succ` in `~/.config/opencode/opencode.json` | `~/.local/share/opencode/auth.json` | `opencode --model succ/<id>` |
| Oh My Pi | `providers.succ` in `~/.omp/agent/models.yml` | that file | `omp --model succ/<id>` |
| Pi | `providers.succ` in `~/.pi/agent/models.json` | that file | `pi --provider succ --model <id>` |
| Claude Desktop | nothing; prints the in-app steps | the app's own field | n/a |

The script honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG` and `PI_CODING_AGENT_DIR`.

It refuses, and changes nothing, when it cannot edit a file safely:
- JSON with comments
- inline YAML or TOML for the succ provider
- a linked or foreign-owned file
- a second Claude key (`apiKeyHelper` or `ANTHROPIC_API_KEY`)
- Oh My Pi profiles or a legacy `models.json`

For a refused tool, use section 3. Afterwards, ask the user to paste the summary, which never contains the key, and report from it.

## 3. Manual setup, when the script cannot be used

Follow the tool's section of https://succ.ai/agent-setup.md and these rules.

- **Inspect first.** Look at the active configuration layers and credential source before changing anything. Don't display secrets.
- **Models.**
  - The public list comes from `node <skill-dir>/scripts/succ-setup.mjs models --json --protocol <protocol>`.
  - To see what the key allows, have the user run `setup --dry-run`.
  - If you must call `GET /v1/models` yourself, read the key inside that process from the tool's credential store or a masked prompt (Python `getpass`, PowerShell `Read-Host -AsSecureString`). Use TLS verification, a timeout and no redirects.
  - Never use `curl -H "Authorization: Bearer $KEY"`, because the key shows up in the process list.
- **Base URLs.** Chat and Responses use `https://api.succ.ai/v1`. Anthropic SDKs and Claude tools use `https://api.succ.ai`, without `/v1`.
- **Eligible models.** Add the models whose protocol flag is true in both the public and the key catalog, with matching metadata. Use the live `context_window` and `max_output_tokens`. Never copy sample values such as 32768/4096.
- **Reasoning efforts.**
  - Expose only the live `reasoning_efforts` the tool can represent. An empty list means sending no effort field at all.
  - In Messages, `none` means `thinking:{type:"disabled"}`, never `output_config.effort:"none"`.
  - Keep a valid existing preference. Otherwise leave effort unset or ask the user.
- **Responses requests.** Send `store:false` and the full input history. Don't use `previous_response_id` or background mode.
- **Merging.** Merge by model ID. Keep other providers, defaults, permissions and budgets. Back up first, and make files that hold the key owner-only. Turn off automatic generation retries where the tool supports it; for Codex that is `request_max_retries = 0` and `stream_max_retries = 0`.

## 4. Claude Desktop

1. Open **Help → Troubleshooting → Enable Developer Mode**, then **Developer → Configure Third-Party Inference**.
2. Set the inference provider to **Gateway** and the base URL to `https://api.succ.ai`, without `/v1`.
3. The user types their key into **Gateway API key**, with credential kind **Static API key** and auth scheme **Bearer**.
4. Leave the model list empty so the app discovers it, then choose **Apply Changes → Save & Restart** and start in third-party mode.

Chat, Cowork and Code are separate surfaces: one working proves nothing about the others. Don't write Claude Code settings for Desktop. On a managed device, don't bypass its policy.

## 5. Verify without spending

Use only checks that list models:

- `opencode models succ`
- `omp models succ --json --no-extensions`
- `pi --offline --no-extensions --no-mcp --list-models succ`
- `codex debug models -c model_provider=succ -c model_catalog_json=<file>`

Don't start a session or send a test prompt. The first real request is the user's decision.

## 6. Report

Include:
- tool and version
- protocol
- files changed (paths only)
- models added, and models excluded with the reason
- start command
- where the key is stored, and that the file is owner-only
- what was left unchanged
- which checks ran

State that no prompt was sent and that inference, streaming and tools were not tested. Never include the key or a raw configuration.
