# Privacy

longhaul runs entirely on your machine. It makes no network calls, sends no telemetry and has no server, so nothing it sees leaves your computer.

## What it reads

- **Your prompts**, as you send them, to match them against the classifier rules. The text is read in memory and never kept.
- **The tool calls in your session**: for an edit, the file path; for a shell command, the command text, checked in memory for a commit or a test run and never kept; for a todo list, whether every item is done; for an MCP tool, the server's name, to count its calls.
- **Session usage that Claude Code reports**: context size, token counts, the weekly limit percentage and its reset time.
- **The context breakdown that Claude Code reports**: which MCP tools are loaded and how many tokens each takes, the memory files it loaded and the number of skills.
- **Those memory files**, to count their lines and find long lines repeated across them. Their contents are not kept.
- **The rules file you name in `rules_file`**, if you set one.

## What it keeps

No files. Everything it keeps is in the storage Claude Code gives each plugin:

- One record per session: the project folder, token counts and estimated costs, limit percentages over time, how many calls went to each MCP server, compactions (when, why, size before and after), handoff outcomes with the rule ids that matched and the files the subagent touched, and the context estimate (paths, line counts, token estimates). Records older than 21 days are deleted.
- A few dates, so a heads-up shows at most once a day or once a week.

## What it runs

No programs.

## Deleting it

Claude Code keeps that storage in one file under `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/store/` whose name starts with `longhaul`. Delete it to clear everything. Uninstalling the plugin stops all reading and keeping.

Version 0.1 kept its records in `<CLAUDE_CONFIG_DIR or ~/.claude>/longhaul/`. Version 0.2 no longer reads that folder, so you can delete it.

## Contact

Questions go to the [issues](https://github.com/sssamuelll/longhaul/issues).
