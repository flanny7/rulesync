# File Formats

## `rulesync/rules/*.md`

Example:

```md
---
root: true # true that is less than or equal to one file for overview such as `AGENTS.md`, false for details such as `.agents/memories/*.md`
localRoot: false # (optional, default: false) true for project-specific local rules. Claude Code: CLAUDE.local.md; Rovodev (Rovo Dev CLI): AGENTS.local.md; Others: append to root file
targets: ["*"] # * = all, or specific tools
description: "Rulesync project overview and development guidelines for unified AI rules management CLI tool"
globs: ["**/*"] # file patterns to match (e.g., ["*.md", "*.txt"])
agentsmd: # agentsmd and codexcli specific parameters
  # Support for using nested AGENTS.md files for subprojects in a large monorepo.
  # This option is available only if root is false.
  # If subprojectPath is provided, the file is located in `${subprojectPath}/AGENTS.md`.
  # If subprojectPath is not provided and root is false, the file is located in `.agents/memories/*.md`.
  subprojectPath: "path/to/subproject"
cursor: # cursor specific parameters
  alwaysApply: true
  description: "Rulesync project overview and development guidelines for unified AI rules management CLI tool"
  globs: ["*"]
antigravity: # antigravity specific parameters
  trigger: "always_on" # always_on, glob, manual, or model_decision
  globs: ["**/*"] # (optional) file patterns to match when trigger is "glob"
  description: "When to apply this rule" # (optional) used with "model_decision" trigger
---

# Rulesync Project Overview

This is Rulesync, a Node.js CLI tool that automatically generates configuration files for various AI development tools from unified AI rule files. The project enables teams to maintain consistent AI coding assistant rules across multiple tools.

...
```

## `.rulesync/hooks.json`

Hooks run scripts at lifecycle events (e.g. session start, before tool use). Events use **canonical camelCase** in this file; Cursor uses them as-is; Claude Code gets PascalCase in `.claude/settings.json`; OpenCode hooks are generated as a JavaScript plugin at `.opencode/plugins/rulesync-hooks.js`; Gemini CLI gets PascalCase (with some specific name mappings) in `.gemini/settings.json`.

**Hook definition fields:**

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Shell command to execute (for command-type hooks) |
| `type` | `"command"` \| `"prompt"` | Hook type (default: `"command"`) |
| `timeout` | number | Timeout in milliseconds |
| `matcher` | string | Pattern to match against (e.g. tool names for `preToolUse`/`postToolUse`) |
| `prompt` | string | Prompt text (for prompt-type hooks) |
| `loop_limit` | number \| null | Maximum number of loop iterations (`null` for unlimited) |
| `name` | string | Hook name identifier |
| `description` | string | Human-readable description of the hook |

**Event support:**

- **Cursor:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `beforeSubmitPrompt`, `stop`, `subagentStop`, `preCompact`, `postToolUseFailure`, `subagentStart`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `afterAgentResponse`, `afterAgentThought`, `beforeTabFileRead`, `afterTabFileEdit`
- **Claude Code:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `beforeSubmitPrompt`, `stop`, `subagentStop`, `preCompact`, `permissionRequest`, `notification`, `setup`, `worktreeCreate`, `worktreeRemove`

> **Note:** `worktreeCreate` and `worktreeRemove` are Claude Code-specific events and do not support the `matcher` field. Any matcher defined in the config will be ignored for these events.

- **OpenCode:** `sessionStart`, `preToolUse`, `postToolUse`, `stop`, `afterFileEdit`, `afterShellExecution`, `permissionRequest`
- **Kilo:** `sessionStart`, `preToolUse`, `postToolUse`, `stop`, `afterFileEdit`, `afterShellExecution`, `permissionRequest`
- **GitHub Copilot:** `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `afterError`
- **Gemini CLI:** `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`, `beforeAgentResponse`, `afterAgentResponse`, `beforeToolSelection`, `preToolUse`, `postToolUse`, `preCompact`, `notification`
- **Codex CLI:** `sessionStart`, `preToolUse`, `postToolUse`, `beforeSubmitPrompt`, `stop`
- **Factory Droid:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `beforeSubmitPrompt`, `stop`, `subagentStop`, `preCompact`, `permissionRequest`, `notification`, `setup`
- **DeepAgents:** `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `permissionRequest`, `postToolUseFailure`, `stop`, `preCompact`

> **Note:** Rulesync implements OpenCode hooks as a plugin, so importing from OpenCode to rulesync is not supported. OpenCode only supports command-type hooks (not prompt-type).

> **Note:** GitHub Copilot's format uses separate `powershell` and `bash` fields for hooks. Rulesync supports only a single `command` field and resolves this by emitting the command under the `powershell` key on Windows, and under the `bash` key on all other platforms.

Use optional **override keys** so tool-specific events and config live in one file without leaking to others: `cursor.hooks` for Cursor-only events, `claudecode.hooks` for Claude Code-only, `opencode.hooks` for OpenCode-only, `kilo.hooks` for Kilo-only, `copilot.hooks` for GitHub Copilot-only, `geminicli.hooks` for Gemini CLI-only, `codexcli.hooks` for Codex CLI-only, `factorydroid.hooks` for Factory Droid-only, `deepagents.hooks` for DeepAgents-only. Events in shared `hooks` that a tool does not support are skipped for that tool (and a warning is logged at generate time).

Example:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "command": ".rulesync/hooks/session-start.sh",
        "name": "session-init",
        "description": "Initialize session environment"
      }
    ],
    "preToolUse": [
      {
        "matcher": "Bash",
        "type": "prompt",
        "prompt": "Review the command before execution for safety",
        "description": "Safety check for shell commands"
      }
    ],
    "postToolUse": [
      {
        "matcher": "Write|Edit",
        "command": ".rulesync/hooks/format.sh",
        "timeout": 10000
      }
    ],
    "stop": [
      {
        "command": ".rulesync/hooks/audit.sh",
        "loop_limit": null
      }
    ]
  },
  "claudecode": {
    "hooks": {
      "worktreeCreate": [{ "command": ".claude/hooks/worktree-setup.sh" }]
    }
  }
}
```

> **Note:** The `claudecode.hooks` override is shown above because `worktreeCreate` and `worktreeRemove` are Claude Code-specific events that do not support the `matcher` field. Use tool-specific override keys only for events exclusive to that tool; shared events belong in the top-level `hooks` section.

**Tool-specific output transformations:**

| Tool | Unique output keys / behavior |
|------|-------------------------------|
| **GitHub Copilot** | `command` is emitted as `bash` (non-Windows) or `powershell` (Windows); `timeout` is emitted as `timeoutSec` |
| **Gemini CLI** | Hooks are grouped by `matcher` in output; relative commands (starting with `./`) are prefixed with `$GEMINI_PROJECT_DIR/` |
| **Claude Code** | Relative commands are prefixed with `$CLAUDE_PROJECT_DIR/`; `worktreeCreate`/`worktreeRemove` ignore `matcher` |
| **Factory Droid** | Relative commands are prefixed with `$FACTORY_PROJECT_DIR/` |
| **OpenCode / Kilo** | Generated as a JavaScript plugin file (not JSON); only `command`-type hooks are supported |
| **Codex CLI** | Hooks are grouped by `matcher` in output; only `command`-type hooks; generates `.codex/config.toml` with feature flag |
| **DeepAgents** | Output uses flat array structure; `command` is emitted as `["bash", "-c", "..."]`; `matcher` is not supported |

## `.copilot/mcp-config.json`

Example:

```json
{
  "mcpServers": {
    "serena": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"]
    },
    "github": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    },
    "local-dev": {
      "type": "local",
      "command": "node",
      "args": ["scripts/start-local-mcp.js"]
    }
  }
}
```

This file is used by the GitHub Copilot CLI for MCP server configuration. Rulesync manages this file by converting from the unified `.rulesync/mcp.json` format.

- **Project mode:** `.copilot/mcp-config.json` (relative to project root)
- **Global mode:** `~/.copilot/mcp-config.json` (relative to home directory)

Rulesync preserves explicit `type` values for `http`, `sse`, and `local` servers. For command-based servers that omit a transport type, Rulesync emits the mandatory `"type": "stdio"` field required by the Copilot CLI.

## `rulesync/commands/*.md`

Example:

```md
---
description: "Review a pull request" # command description
targets: ["*"] # * = all, or specific tools
copilot: # copilot specific parameters (optional)
  description: "Review a pull request"
antigravity: # antigravity specific parameters
  trigger: "/review" # Specific trigger for workflow (renames file to review.md)
  turbo: true # (Optional, default: true) Append // turbo for auto-execution
---

target_pr = $ARGUMENTS

If target_pr is not provided, use the PR of the current branch.

Execute the following in parallel:

...
```

## `rulesync/subagents/*.md`

Example:

```md
---
name: planner # subagent name
targets: ["*"] # * = all, or specific tools
description: >- # subagent description
  This is the general-purpose planner. The user asks the agent to plan to
  suggest a specification, implement a new feature, refactor the codebase, or
  fix a bug. This agent can be called by the user explicitly only.
claudecode: # for claudecode-specific parameters
  model: inherit # opus, sonnet, haiku or inherit
copilot: # for GitHub Copilot specific parameters
  tools:
    - web/fetch # agent/runSubagent is always included automatically
opencode: # for OpenCode-specific parameters
  mode: subagent # (optional, defaults to "subagent") OpenCode agent mode
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  tools:
    write: false
    edit: false
    bash: false
  permission:
    bash:
      "git diff": allow
---

You are the planner for any tasks.

Based on the user's instruction, create a plan while analyzing the related files. Then, report the plan in detail. You can output files to @tmp/ if needed.

Attention, again, you are just the planner, so though you can read any files and run any commands for analysis, please don't write any code.
```

> **Gemini CLI note (as of 2026-04-01):** Subagents are generated to `.gemini/agents/`. To enable the agents feature, set `"experimental": { "enableAgents": true }` in your `.gemini/settings.json`.

## `.rulesync/skills/*/SKILL.md`

Example:

```md
---
name: example-skill # skill name
description: >- # skill description
  A sample skill that demonstrates the skill format
targets: ["*"] # * = all, or specific tools
claudecode: # for claudecode-specific parameters
  model: sonnet # opus, sonnet, haiku, or any string
  allowed-tools:
    - "Bash"
    - "Read"
    - "Write"
    - "Grep"
  disable-model-invocation: true # (optional) disable model invocation for this skill
codexcli: # for codexcli-specific parameters
  short-description: A brief user-facing description
---

This is the skill body content.

You can provide instructions, context, or any information that helps the AI agent understand and execute this skill effectively.

The skill can include:

- Step-by-step instructions
- Code examples
- Best practices
- Any relevant context

Skills are directory-based and can include additional files alongside SKILL.md.
```

## `.rulesync/mcp.json`

Example:

```json
{
  "mcpServers": {
    "$schema": "https://github.com/dyoshikawa/rulesync/releases/latest/download/mcp-schema.json",
    "serena": {
      "description": "Code analysis and semantic search MCP server",
      "type": "stdio",
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/oraios/serena",
        "serena",
        "start-mcp-server",
        "--context",
        "ide-assistant",
        "--enable-web-dashboard",
        "false",
        "--project",
        "."
      ],
      "env": {}
    },
    "context7": {
      "description": "Library documentation search server",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": {}
    }
  }
}
```

#### JSON Schema Support

Rulesync provides a JSON Schema for editor validation and autocompletion. Add the `$schema` property to your `.rulesync/mcp.json`:

```json
{
  "$schema": "https://github.com/dyoshikawa/rulesync/releases/latest/download/mcp-schema.json",
  "mcpServers": {}
}
```

### MCP Tool Config (`enabledTools` / `disabledTools`)

You can control which individual tools from an MCP server are enabled or disabled using `enabledTools` and `disabledTools` arrays per server.

```json
{
  "mcpServers": {
    "serena": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"],
      "enabledTools": ["search_symbols", "find_references"],
      "disabledTools": ["rename_symbol"]
    }
  }
}
```

- `enabledTools`: An array of tool names that should be explicitly enabled for this server.
- `disabledTools`: An array of tool names that should be explicitly disabled for this server.

## `.rulesync/.aiignore` or `.rulesyncignore`

Rulesync supports a single ignore list that can live in either location below:

- `.rulesync/.aiignore` (recommended)
- `.rulesyncignore` (project root)

Rules and behavior:

- You may use either location.
- When both exist, Rulesync prefers `.rulesync/.aiignore` (recommended) over `.rulesyncignore` (legacy) when reading.
- If neither file exists yet, Rulesync defaults to creating `.rulesync/.aiignore`.

Notes:

- Running `rulesync init` will create `.rulesync/.aiignore` if no ignore file is present.

Example:

```ignore
tmp/
credentials/
```
