# Claude Code transcript observation

Status: Accepted

Explicit `claudeSources` in the server-owned observer configuration opt into Claude Code JSONL parsing. Existing `sources` keep their Codex meaning. A transcript identifies the agent tool (`claude_code_local`); model names do not identify its upstream provider, channel or subscription. Those remain unknown absent durable evidence. Recorded cwd uses the existing tenant/organization workspace attribution rules.

Only assistant message identity, timestamp, cwd, model, CLI version and numeric usage survive parsing. Input includes uncached, cache-write and cache-read tokens; cached is the cache-read subset. Missing required counters remain unobserved. A stable session/message/request identity deduplicates streamed blocks and copies. Monotonic complete token revisions update the same client-observed row, never an authoritative billing fact. Prompt/response content is neither retained nor logged.

The SQL source check and analytics query/response enums expand to `claude_code_local`. Session grouping includes the tool source to prevent cross-tool ID collisions. Local observations do not create gateway requests, charges, wallet entries or subscription quota facts. Operator rollback keeps the additive constraint and stops the new source.

Sources: [Claude Code data directories](https://code.claude.com/docs/en/claude-directory), [Anthropic cache usage semantics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and locally inspected metadata-only transcript shapes.
