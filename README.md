# longhaul

A Claude Code mod that helps Pro and Max subscribers make the weekly usage limit last.

## Install

At the prompt of a terminal session:

```
/plugin install longhaul --marketplace sssamuelll/longhaul
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install longhaul --marketplace sssamuelll/longhaul
```

## The problem

These are one developer's own measurements, taken from their sessions over a day and a half and weighted by public API prices. Your numbers will differ.

- 36% of the weekly limit was used in about 1.5 days.
- 56% of the usage was Claude re-reading the conversation.
- A typical step carried about 390k tokens of context.
- Auto-compact fired only near 967k, the default for a 1M-token model.
- Compacting at 200k would have saved about 25%.
- Every session started at about 93k tokens before the first prompt.
- Sonnet 5.5 costs half of Opus 5.5 on every token type.

A long conversation is paid for again on every step. Keeping it short, and giving cheap work to the cheaper model, is where the savings are.

## What it does

Five jobs. The guard and classifier have three modes each: `auto` acts, `ask` asks first, `off` does nothing. The meter and context health take `auto` or `off`, and the report is read on demand.

1. **Context guard.** Above the soft limit, it compacts the conversation at a safe moment between tasks: after a commit, a passing test run, finished todos, or when your next prompt starts something new. Above the hard limit it compacts at the end of the turn, even mid-task. The summary is told to keep the plan, the decisions, the files touched and your corrections. Your own compaction instructions are never replaced. Every compaction writes one line to the transcript (sizes and why it happened) and is logged, so the report can show them. It never compacts again until the conversation has grown 50k tokens past where the last compaction left it, so a conversation that cannot shrink below the soft limit is not compacted over and over.
2. **Classifier.** Local rules read each prompt, in English and Spanish. Execution work, such as plan steps, mechanical edits and searches, gets a short instruction to hand it to a Sonnet subagent and review the result. Design, architecture, security and decisions stay on the main model. The handoff instruction is added only when the main session runs on Opus or Fable; on Sonnet it would only add a step. Separately, only the built-in general-purpose and Explore subagents are moved to Sonnet, and agent types whose name contains a `keep_on_opus` fragment are left alone. A custom agent runs on the model its definition names, and one with no `model:` line inherits the main session's model and stays on it.

   The rules live in `<data folder>/rules.json` (see Privacy for the data folder). Each rule has an `id`, a `verdict` (`opus` or `sonnet`), a `pattern` and optionally `flags`. The file is created from the defaults on the first run and loaded once per session. If it is broken, the defaults are used and the file is not overwritten.
3. **Meter.** One row right above the prompt, three small gauges in their own colours: context size against the hard limit, weekly use, and today's use against the daily allowance, then how far the week lasts at the current pace. Once a day, if today runs well ahead of the allowance, a calm line above it says how long the week lasts at this pace and where to look.
4. **Report.** Where the week's tokens went, and why. Biggest sessions, handoff outcomes, a Compactions section (how many, why, typical size before and after), and suggestions. It never edits your configuration.
5. **Context health.** Once per session, after the first reply, it takes a free local estimate of what every session loads before any work: MCP tools per server, memory files and skills. It also finds long lines repeated across memory files. `/longhaul health` lists the items biggest first and says how to lighten them (`/mcp` to turn a server off for a project, shorten or split a memory file, keep repeated text in one file). At most once a week, a line above the prompt points to it when MCP tools you did not use this week or repeated text make up a large part of the start. Only paths, line counts and token estimates are kept, never file contents.

## Settings

| Option | Default | Values |
|---|---|---|
| `guard_mode` | `auto` | `auto`, `ask`, `off` |
| `classifier_mode` | `auto` | `auto`, `ask`, `off` |
| `budget_mode` | `auto` | `auto`, `off` |
| `health_mode` | `auto` | `auto`, `off` |
| `soft_limit` | `150000` | 100000 to 1000000 tokens |
| `hard_limit` | `300000` | 100000 to 1000000 tokens, higher than `soft_limit` |
| `explore_model` | `sonnet` | `sonnet`, `haiku` |
| `keep_on_opus` | `review,design,plan,architect` | comma-separated agent-type name fragments |

## Commands

- `/longhaul` prints the report in the terminal.
- `/longhaul page` writes a local HTML page and opens it in the browser.
- `/longhaul health` shows what every session loads before any work.

## What it changes, sends, runs and writes

- **Prompts.** When a classifier rule matches and the main session runs on Opus or Fable, the mod adds one note to the prompt's context; your text is not changed. In `auto` the note reads: "longhaul: this looks like execution work. Delegate it to a Sonnet subagent with a short brief (goal, files, how to check it). Review its changes and test results before accepting, then call mcp__longhaul__review with accepted, fixed or redone." In `ask` it tells Claude to ask you first. When a new task starts past the soft limit in an interactive session, the prompt is held, the conversation compacts, and the mod submits the same text again, unchanged. If that fails, it puts the text back in the prompt box.
- **Subagents.** The `agent.spawn` hook sets the model of the built-in general-purpose and Explore subagents to Sonnet (Explore to `explore_model`) when the main session runs on Opus or Fable and the spawn names no model. Forks, spawns that name a model and agent types that match `keep_on_opus` pass unchanged. It never changes an agent's permission mode.
- **Compaction.** The `session.compact` hook adds the keep-list after your own compaction instructions: "Keep, in this order: the current plan and its next step; the decisions made and why; the files touched; open items and failing tests; anything the user corrected or asked for in this session."
- **The band.** The `ui.render` hook draws the meter and its notes above the prompt. With nothing to show, Claude Code draws its own.
- **Everything else only observes.** The `tool.call`, `turn.step`, `turn.complete`, `session.start` and `session.end` hooks pass every event on unchanged. They count tokens, compactions and MCP calls, and note which files were edited. `command.run` answers only `/longhaul`, and the `review` tool records how a handoff went.
- **Sends.** Nothing leaves your machine: no network calls, no telemetry. The resubmitted prompt, the note and the keep-list reach Claude through Claude Code, like your own prompts.
- **Runs.** Only your system's file opener (`explorer.exe` on Windows, `open` on macOS, `xdg-open` on Linux), to show the local report page when you run `/longhaul page`.
- **Writes.** Only inside `<CLAUDE_CONFIG_DIR or ~/.claude>/longhaul/`: one JSON record per session, `rules.json`, and `report.html` for `/longhaul page`. Plus a few dates in Claude Code's plugin storage, so a heads-up shows at most once a day or once a week. It never edits build, start-up, settings or instructions files.

## Privacy

Everything stays on your machine. The mod makes no network calls and sends no telemetry. The decision log never stores prompt text. Data lives in `<CLAUDE_CONFIG_DIR or ~/.claude>/longhaul/`. [PRIVACY.md](PRIVACY.md) lists everything it reads and writes.

## What it can't do

- **With on-demand tool loading, only loaded schemas count.** Context health counts the tool schemas that are already loaded for a server, so a server whose tools load on demand can look smaller than it is. A server is called unused only after the mod's records go back 3 days; before that the list says when it started recording and gives no turn-off advice.
- **No history from before installation.** The report reads only the mod's own records, not Claude Code's transcripts, so it starts from the day you install. For older history, use [ccusage](https://github.com/ccusage/ccusage). A mod cannot delete files, so session records stay on disk; the report skips those older than 21 days.
- **Token splits and dollar figures are estimates.** Anthropic does not publish how the limit weighs each token type, so these use API prices. The measured percent of the week is the only measured number.
- **Compaction waits for the hook.** Claude Code won't compact while a hook holds a prompt. In interactive sessions, a new-task prompt past the soft limit is held, the conversation compacts, and the same text is sent again. In non-interactive runs it never holds a prompt and compacts only at the end of a turn.
- **Organisation-managed Claude Code.** There, `session.compact` hooks don't run in installed plugins. The keep-list is then not added to Claude Code's own compactions, and those aren't counted. The mod's own compactions still pass the keep-list directly.
- **It can't switch the main model.** It tells Claude to hand execution work to a Sonnet subagent, and keeps built-in subagents off Opus.
- **Whether the built-in Explore agent honours the model change is still being verified.**

## Works well with

[context-mode](https://github.com/mksglu/context-mode) and [headroom](https://github.com/headroomlabs-ai/headroom) shrink what goes into the conversation. longhaul manages how long it runs and who does the work.

## Licence

MIT.
