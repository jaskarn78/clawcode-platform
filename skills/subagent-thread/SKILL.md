---
name: subagent-thread
description: "Spawn subagent sessions in dedicated Discord threads for visible, isolated task execution."
version: "1.0.0"
owner: "*"
---
Spawn subagent sessions in dedicated Discord threads for visible, isolated task execution.

## When to Use

Use this skill when you need to delegate a task to a subagent AND want the work to be visible in Discord. This creates a new Discord thread where the subagent operates independently.

Use this ONLY when the user explicitly asks for a thread or a visible subagent, for example when:
- The task should be visible to Discord channel members
- You want the subagent's conversation isolated in its own thread
- You need to share the thread URL with others

## How to Use

You have an MCP tool available: `spawn_subagent_thread`

Call it with:
- `agent`: Your agent name (required)
- `threadName`: A descriptive name for the thread (required)
- `task`: **(Strongly recommended)** The work you're handing off. When provided, the subagent starts working immediately and posts its response in the thread — you do **not** need to send a follow-up message. Omit only when you want a blank thread for interactive back-and-forth.
- `model`: Optional model override ("sonnet", "opus", "haiku", "fable")
  - `fable` = Claude Fable 5.1, the top tier above opus ($10/$50 per MTok — use deliberately)
- `systemPrompt`: Optional personality/role override (not the task itself — use `task` for that)

The tool returns:
- Thread URL (shareable Discord link)
- **Thread ID** (save this — you need it to read the thread later)
- Session name (for tracking)
- Parent agent and channel info

**Rule of thumb:** if the user asked you to "spawn a subagent to do X", pass X as `task`. That's the whole point — hand off once, don't ping-pong.

## Reading back what the subagent posted

Once the subagent has had time to work, use the `read_thread` MCP tool with the threadId you saved:

- `threadId`: the thread ID from spawn_subagent_thread (required)
- `limit`: how many recent messages to return (1-100, default 20)

This returns every message in the thread — the subagent's work, your own follow-ups, attachments. Use it to summarize subagent output back to the user without them having to paste anything.

## Alternatively via CLI

```bash
clawcode spawn-thread --agent <your-name> --name "Task description" [--model sonnet] [--prompt "Custom instructions"]
```

## Error Cases

- **No Discord client**: The daemon must be running with Discord bridge enabled
- **No bound channel**: Your agent must have at least one Discord channel configured
- **Max sessions reached**: Thread session limit per agent (default 3) -- wait for existing subagents to finish

## Cleanup

Subagent threads are automatically cleaned up when the subagent session ends. The Discord thread is preserved for history.
