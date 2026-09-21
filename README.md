# pi-image-generation

```sh
pi install npm:oira666_pi-image-generation
```

Generate and edit PNG images with the `image_gen` tool. Without settings, the extension uses the stored `openai-codex` subscription login, as before.

## Credentials

Create `~/.pi/agent/pi-image-generation-settings.json` to choose a different OpenAI provider registered in pi:

```json
{
  "provider": "openai-dmitry"
}
```

Pi resolves the selected provider's credentials and manages OAuth refresh. A Codex subscription alias uses the ChatGPT image backend. A provider resolving an OpenAI API key uses the OpenAI Images API.

Alternatively, supply a literal OpenAI API key (billed to your OpenAI API account):

```json
{
  "apiKey": "sk-your-openai-api-key"
}
```

Use **exactly one** of `provider` or `apiKey`. Empty, malformed, unreadable, or ambiguous settings disable image generation with a warning; they never fall back to another account. API keys are literal strings, not shell commands or environment-variable expressions.

### Project overrides

In a trusted project, settings are checked in this order (first existing file wins):

1. `.pi/agent/pi-image-generation-settings.json`
2. `.pi/pi-image-generation-settings.json` (standard pi project config directory)
3. `~/.pi/agent/pi-image-generation-settings.json`

Project settings replace the whole global file, so a project provider does not inherit a global API key. Untrusted projects use only global settings. `PI_CODING_AGENT_DIR` overrides the global agent directory.

Run `/reload` after changing settings or logging in to update tool and skill availability. Credentials are also checked again on each tool call. The active conversation model can use any provider.

Only OpenAI credentials are supported: selected subscription providers must have a `https://chatgpt.com` base URL, and API-key providers a `https://api.openai.com` base URL. Other or unknown origins are rejected to avoid sending another service's credentials to OpenAI. Image requests use fixed OpenAI endpoints, not custom provider paths or headers. There is no automatic fallback between accounts or services.

Keep API-key settings private (`chmod 600 <settings-file>`) and do not commit them to source control. Image prompts and supplied references are uploaded to the selected image service.
