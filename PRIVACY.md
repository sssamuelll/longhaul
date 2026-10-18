# Privacy

longhaul runs entirely on your machine. It makes no network calls, sends no telemetry and has no server, so nothing it sees leaves your computer.

## What it reads

- **Your prompts**, as you send them, to match them against the classifier rules. The text is read in memory and never written anywhere.
- **Session usage that Claude Code reports**: context size, token counts, the weekly limit percentage and its reset time.
- **The context breakdown that Claude Code reports**: which MCP tools are loaded and how many tokens each takes, the memory files it loaded and the number of skills.
- **Those memory files**, to count their lines and find long lines repeated across them. Their contents are not kept.
- **Four environment variables**, to find the data folder: `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE` and `OS`.

## What it writes

Everything goes to `<CLAUDE_CONFIG_DIR or ~/.claude>/longhaul/`:

- One record per session: the project folder, token counts and estimated costs, limit percentages over time, how many calls went to each MCP server, compactions (when, why, size before and after), handoff outcomes with the rule ids that matched and the files the subagent touched, and the context estimate (paths, line counts, token estimates).
- `rules.json`, the classifier rules, created from the defaults on the first run.
- `report.html`, only when you run `/longhaul page`.

It also keeps a few dates in Claude Code's own plugin storage, so a heads-up shows at most once a day or once a week.

## What it runs

Only your system's file opener (`explorer.exe`, `open` or `xdg-open`), to show the local report page when you run `/longhaul page`.

## Deleting it

Delete the `longhaul` folder above. Uninstalling the plugin stops all reading and writing.

## Contact

Questions go to the [issues](https://github.com/sssamuelll/longhaul/issues).
