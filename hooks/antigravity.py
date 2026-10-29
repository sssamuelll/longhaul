#!/usr/bin/env python3
"""Antigravity lifecycle hook adapter for longhaul.

Reads exact token counts (input_tokens + cache_read_tokens) and tool activity
incrementally from Antigravity's transcript.jsonl, renders the persistent
longhaul bar via metadata.user_markdown (zero model tokens), classifies prompts
for subagent delegation, and triggers state-aware smart compaction checkpoints.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

SEP = " · "
SOFT_LIMIT = int(os.environ.get("LONGHAUL_SOFT_LIMIT", "150000"))
HARD_LIMIT = int(os.environ.get("LONGHAUL_HARD_LIMIT", "300000"))
MIN_GROWTH = 50_000
MIN_TASK_TURNS = 2
STATE_PATH = Path.home() / ".cache" / "longhaul-antigravity-state.json"

REASON_LABEL = {
    "task-done": "task looks done",
    "new-task": "new task",
    "hard-limit": "over the hard limit",
    "manual": "manual",
}

KEEP_LIST = "\n".join([
    "Keep in the summary:",
    "- every file path that was created, edited or deleted, and what changed in it",
    "- the exact commands that ran and whether they passed or failed, with the error text if still unresolved",
    "- decisions already made and the reasons, so they are not revisited",
    "- open TODOs, the current step, and what the user asked for last",
])

DROP_LIST = "\n".join([
    "Drop from the summary:",
    "- raw file contents, long diffs, and full command or test outputs that already passed",
    "- dead-end exploration, rejected hypotheses, and intermediate search results",
    "- repeated status updates or tool call logs superseded by later edits",
])

AGY_HANDOFF = (
    "longhaul: this looks like execution work. Delegate it to a lighter subagent "
    'via invoke_subagent (TypeName: "self" or "research", Model: "flash") with a '
    "short brief (goal, files, how to check it), then review its changes and test "
    "results before accepting."
)

COMMIT_RE = re.compile(
    r"\b(?:git\s+(?:-C\s+\S+\s+)?commit\b(?!.*--dry-run)|gh\s+pr\s+(?:create|merge)\b)"
)
TEST_RE = re.compile(
    r"\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|(?:npx|bunx|pnpm(?:\s+exec)?|yarn)\s+(?:vitest|jest|playwright)|vitest|jest|(?:uv\s+run\s+|python3?\s+-m\s+)?pytest|cargo\s+test|go\s+test|pytest)\b"
)

NEW_TASK_PATTERNS = [
    re.compile(r"^(?:now|next)\s+(?:let'?s|can\s+you|please|we\s+need\s+to|i\s+want\s+to)\b", re.I),
    re.compile(r"^(?:ahora|siguiente)\s+(?:vamos\s+a|hay\s+que|quiero|puedes| toca)\b", re.I),
    re.compile(r"^(?:moving\s+on|unrelated|separate\s+question|new\s+task|another\s+thing|switching\s+gears|different\s+topic)\b", re.I),
    re.compile(r"^(?:otra\s+cosa| cambiando\s+de\s+tema|por\s+otro\s+lado|nueva\s+tarea|aparte\s+de\s+eso)\b", re.I),
    re.compile(r"^(?:done\s+with\s+that|that'?s\s+done|ok\s+great\s*,?\s*now|great\s*,?\s*now\s+let'?s)\b", re.I),
    re.compile(r"^(?:listo\s+con\s+eso|ya\s+qued[oó]\s*,?\s*ahora|perfecto\s*,?\s*ahora\s+vamos)\b", re.I),
]

STOPWORDS = {
    "the", "a", "an", "to", "in", "on", "of", "for", "and", "or", "is", "it",
    "this", "that", "with", "from", "by", "at", "be", "as", "are", "was", "were",
    "can", "you", "please", "lets", "let", "now", "we", "i", "my", "me", "do",
    "el", "la", "los", "las", "un", "una", "de", "del", "en", "y", "o", "que",
    "es", "por", "para", "con", "se", "al", "como", "mas", "pero", "su", "le",
    "ya", "me", "si", "sin", "sobre", "este", "esta", "esto", "eso", "vamos",
}

OPUS_PATTERNS = [
    re.compile(r"\b(?:why\s+does|why\s+is|root\s+cause|investigate|diagnose|race\s+condition|deadlock|memory\s+leak|flaky)\b", re.I),
    re.compile(r"\b(?:por\s+qu[eé]\s+falla|causa\s+ra[ií]z|investiga|diagnostica)\b", re.I),
    re.compile(r"\b(?:architect(?:ure)?|trade-?offs?|design\s+a|should\s+we\s+use|compare\s+.+\s+vs|best\s+approach|most\s+natural\s+next\s+step)\b", re.I),
    re.compile(r"\b(?:arquitectura|dise[nñ]a|mejor\s+forma|m[aá]s\s+profesional|siguiente\s+paso\s+m[aá]s\s+natural)\b", re.I),
    re.compile(r"\b(?:review\s+(?:this|the)\s+(?:pr|diff|design|plan)|security\s+audit|threat\s+model)\b", re.I),
    re.compile(r"\b(?:delete|drop|remove)\s+(?:the\s+)?(?:old\s+)?(?:migration|table|database|prod|production)\b", re.I),
]

SONNET_PATTERNS = [
    re.compile(r"\b(?:run\s+(?:the\s+)?(?:tests?|lint|build|typecheck)|fix\s+(?:the\s+)?(?:lint|type|import|formatting)\s+errors?)\b", re.I),
    re.compile(r"\b(?:rename\s+\w+\s+to\s+\w+|update\s+snapshots?|bump\s+version)\b", re.I),
    re.compile(r"^(?:where\s+is|where\s+are|find\s+the\s+file|list\s+all|d[oó]nde\s+est[aá]n?)\b", re.I),
    re.compile(r"^(?:go\s+with|continue\s+with|do\s+the\s+next\s+step|ejecuta\s+el\s+hito|arranca\s+con|vamos\s+con)\s+(?:task|step|phase|hito|b)?\s*\d*\b", re.I),
]


def empty_facts() -> dict[str, Any]:
    return {
        "editedFiles": [],
        "committed": False,
        "testsPassed": False,
        "editedAfterTests": False,
    }


def strip_quotes(val: Any) -> str:
    s = str(val or "").strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        try:
            parsed = json.loads(s)
            if isinstance(parsed, str):
                return parsed
        except Exception:
            return s[1:-1]
    return s


def observe_tool(facts: dict[str, Any], tool: str, args: dict[str, Any], is_error: bool) -> dict[str, Any]:
    edited = list(facts.get("editedFiles") or [])
    committed = bool(facts.get("committed"))
    tests_passed = bool(facts.get("testsPassed"))
    edited_after_tests = bool(facts.get("editedAfterTests"))

    if tool in ("edit_file", "write_file", "Edit", "Write", "MultiEdit"):
        p = strip_quotes(args.get("Path") or args.get("file_path") or "")
        if p and p not in edited:
            edited.append(p)
        if tests_passed:
            edited_after_tests = True
        committed = False
    elif tool in ("run_command", "Bash"):
        cmd = strip_quotes(args.get("CommandLine") or args.get("command") or "")
        if not is_error and COMMIT_RE.search(cmd):
            committed = True
        if TEST_RE.search(cmd):
            if not is_error:
                tests_passed = True
                edited_after_tests = False
            else:
                tests_passed = False

    return {
        "editedFiles": edited,
        "committed": committed,
        "testsPassed": tests_passed,
        "editedAfterTests": edited_after_tests,
    }


def is_task_done(facts: dict[str, Any]) -> bool:
    if facts.get("committed"):
        return True
    edited = facts.get("editedFiles") or []
    if edited and facts.get("testsPassed") and not facts.get("editedAfterTests"):
        return True
    return False


def content_words(text: str) -> set[str]:
    words = re.findall(r"[a-zA-ZáéíóúñÁÉÍÓÚÑ0-9_]{3,}", text.lower())
    return {w for w in words if w not in STOPWORDS}


def is_new_task(prompt: str, recent_prompts: list[str]) -> bool:
    trimmed = prompt.strip()
    if not trimmed:
        return False
    for pat in NEW_TASK_PATTERNS:
        if pat.search(trimmed):
            return True
    if len(recent_prompts) < MIN_TASK_TURNS:
        return False
    cur = content_words(trimmed)
    if len(cur) < 5:
        return False
    prev: set[str] = set()
    for p in recent_prompts[-3:]:
        prev |= content_words(p)
    if len(prev) < 5:
        return False
    if len(cur & prev) > 0:
        return False
    return True


def classify_prompt(prompt: str) -> str:
    text = prompt.strip()
    if len(text) < 8:
        return "neutral"
    for pat in OPUS_PATTERNS:
        if pat.search(text):
            return "opus"
    for pat in SONNET_PATTERNS:
        if pat.search(text):
            return "sonnet"
    return "neutral"


def build_compact_instructions(
    reason: str | None,
    edited_files: list[str],
    committed: bool,
    tests_passed: bool,
    edited_after_tests: bool,
) -> str:
    sections: list[str] = []
    if reason in ("task-done", "new-task"):
        sections.append(
            "The previous task reached a clean boundary. Compress its implementation "
            "history into a concise outcome record (what changed, which files were "
            "touched, how it was verified) and discard step-by-step tool transcripts."
        )
    elif reason == "hard-limit":
        sections.append(
            "Context reached the hard token limit mid-task. Aggressively prune "
            "completed sub-steps and bulky tool outputs while preserving exact state "
            "for the active in-progress work."
        )

    state_lines: list[str] = []
    if edited_files:
        shown = edited_files[:25]
        more = f" (+{len(edited_files) - 25} more)" if len(edited_files) > 25 else ""
        state_lines.append(f"- files modified in this epoch: {', '.join(shown)}{more}")
    status_parts: list[str] = []
    if committed:
        status_parts.append("changes committed")
    if tests_passed and not edited_after_tests:
        status_parts.append("tests passing")
    elif edited_after_tests:
        status_parts.append("files edited after last test run (re-test needed)")
    if status_parts:
        state_lines.append(f"- verification status: {', '.join(status_parts)}")
    if state_lines:
        sections.append("Session state to preserve verbatim:\n" + "\n".join(state_lines))

    sections.append(DROP_LIST)
    sections.append(KEEP_LIST)
    return "\n\n".join(sections)


def bar_str(r: float, width: int = 8) -> str:
    clamped = max(0.0, min(1.0, r))
    n = max(0, min(width, round(clamped * width)))
    return "▰" * n + "▱" * (width - n)


def fmt_k(n: int) -> str:
    return f"{max(0, round(n / 1000))}k"


def render_markdown_bar(ctx: int, hard: int, sess: dict[str, Any], event_line: str | None) -> str:
    r = (ctx / hard) if hard > 0 else 0.0
    meter = f"▎ context {bar_str(r, 8)} {fmt_k(ctx)}/{fmt_k(hard)}"
    extras: list[str] = []
    epoch_files = sess.get("epochFiles") or []
    if epoch_files:
        n = len(epoch_files)
        extras.append(f"{n} file{'' if n == 1 else 's'} touched")
    facts = sess.get("facts") or {}
    if facts.get("committed"):
        extras.append("committed")
    elif facts.get("testsPassed") and not facts.get("editedAfterTests"):
        extras.append("tests green")
    suffix = f"{SEP}{SEP.join(extras)}" if extras else ""
    line = f"`{meter}{suffix}`"
    return f"*{event_line}*\n{line}" if event_line else line


def estimate_base_overhead() -> dict[str, Any]:
    mcp_tokens = 0
    mcp_by_server: dict[str, dict[str, int]] = {}
    mcp_dir = Path.home() / ".gemini" / "antigravity-cli" / "mcp"
    if mcp_dir.is_dir():
        for srv in sorted(mcp_dir.iterdir()):
            if not srv.is_dir():
                continue
            chars = 0
            count = 0
            for f in srv.glob("*.json"):
                try:
                    chars += f.stat().st_size
                    count += 1
                except OSError:
                    pass
            toks = round(chars / 4)
            mcp_tokens += toks
            mcp_by_server[srv.name] = {"tools": count, "tokens": toks}

    mem_tokens = 0
    memory: list[dict[str, Any]] = []
    for p_str in ("/mnt/c/Users/simon/AGENTS.md", "/mnt/c/Users/simon/.claude/CLAUDE.md"):
        p = Path(p_str)
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
            toks = round(len(text) / 4)
            mem_tokens += toks
            memory.append({"path": p_str, "tokens": toks, "lines": text.count("\n") + 1})
        except OSError:
            pass

    skill_count = 0
    skills_dir = Path("/mnt/c/Users/simon/.agents/skills")
    try:
        if skills_dir.is_dir():
            skill_count = sum(1 for _ in skills_dir.iterdir())
    except OSError:
        pass
    skill_tokens = skill_count * 95
    total = mcp_tokens + mem_tokens + skill_tokens + 8000
    return {
        "at": int(time.time() * 1000),
        "total": total,
        "mcp": mcp_by_server,
        "memory": memory,
        "skills": {"count": skill_count, "tokens": skill_tokens},
    }


def load_state() -> dict[str, Any]:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"sessions": {}, "mcpCalls": {}, "startedAt": int(time.time() * 1000)}


def save_state(state: dict[str, Any]) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
    except Exception:
        pass


def sync_from_transcript(sess: dict[str, Any], state: dict[str, Any], transcript_path: str | None) -> None:
    if not transcript_path:
        return
    p = Path(transcript_path)
    try:
        size = p.stat().st_size
    except OSError:
        return

    offset = int(sess.get("lastScannedOffset") or 0)
    if size < offset:
        offset = 0
    if size == offset:
        return

    pending_tools: list[tuple[str, dict[str, Any]]] = []
    try:
        with p.open("rb") as f:
            f.seek(offset)
            raw_bytes = f.read()
            new_offset = f.tell()
    except OSError:
        return

    sess["lastScannedOffset"] = new_offset
    for raw_line in raw_bytes.decode("utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            step = json.loads(line)
        except Exception:
            continue

        step_type = step.get("type")
        if step_type == "PLANNER_RESPONSE":
            in_tok = int(step.get("input_tokens") or 0)
            cache_tok = int(step.get("cache_read_tokens") or 0)
            step_ctx = in_tok + cache_tok
            if step_ctx > 0:
                prev_ctx = int(sess.get("lastCtx") or 0)
                if prev_ctx > 0 and (prev_ctx - step_ctx) >= 25_000:
                    before_k = prev_ctx // 1000
                    after_k = step_ctx // 1000
                    saved_k = max(0, (prev_ctx - step_ctx) // 1000)
                    sess["pendingEvent"] = (
                        f"compacted {before_k}k → {after_k}k{SEP}"
                        f"saved ~{saved_k}k tokens per turn from here on"
                    )
                    sess["floor"] = step_ctx
                    sess["epochFiles"] = []
                    sess["facts"] = empty_facts()
                sess["lastCtx"] = step_ctx
                sess["peakCtx"] = max(int(sess.get("peakCtx") or 0), step_ctx)

            pending_tools.clear()
            for tc in step.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                t_name = str(tc.get("name") or "")
                t_args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                pending_tools.append((t_name, t_args))
                if t_name == "call_mcp_tool":
                    srv = strip_quotes(t_args.get("ServerName") or "")
                    if srv:
                        state["mcpCalls"][srv] = int(state["mcpCalls"].get(srv) or 0) + 1

        elif step_type == "GENERIC" and pending_tools:
            t_name, t_args = pending_tools.pop(0)
            content = str(step.get("content") or "")
            is_err = (
                step.get("status") == "ERROR"
                or "Command exited with code 1" in content
                or "Command exited with code 2" in content
            )
            sess["facts"] = observe_tool(sess.get("facts") or empty_facts(), t_name, t_args, is_err)
            epoch_files = sess.setdefault("epochFiles", [])
            for ef in sess["facts"].get("editedFiles") or []:
                if ef and ef not in epoch_files:
                    epoch_files.append(ef)


def render_health_report(base: dict[str, Any], mcp_calls: dict[str, int]) -> str:
    total_k = round(base.get("total", 0) / 1000)
    lines = [f"longhaul health — ~{total_k}k base overhead loaded every turn", ""]
    lines.append("MCP servers (lazy tool schemas on disk):")
    for srv, info in sorted(base.get("mcp", {}).items(), key=lambda x: -x[1].get("tokens", 0)):
        calls = mcp_calls.get(srv, 0)
        status = f"{calls} calls" if calls else "unused"
        lines.append(f"  - {srv}: {info.get('tools', 0)} tools (~{fmt_k(info.get('tokens', 0))}) · {status}")
    lines.append("")
    lines.append("Memory files:")
    for m in base.get("memory", []):
        lines.append(f"  - {m['path']}: {m['lines']} lines (~{fmt_k(m['tokens'])})")
    skills = base.get("skills", {})
    lines.append(f"\nSkills index: {skills.get('count', 0)} skills (~{fmt_k(skills.get('tokens', 0))})")
    return "\n".join(lines)


def main() -> None:
    event_type = sys.argv[1] if len(sys.argv) > 1 else "PreInvocation"
    if event_type in ("PostToolUse", "PostInvocation", "Stop"):
        sys.stdout.write("{}\n")
        return
    raw = sys.stdin.read()
    payload: dict[str, Any] = {}
    if raw.strip():
        try:
            payload = json.loads(raw)
        except Exception:
            pass

    conv_id = str(payload.get("conversationId") or "default")
    state = load_state()
    state.setdefault("mcpCalls", {})
    state.setdefault("sessions", {})

    now_ms = int(time.time() * 1000)
    base = state.get("baseSnapshot")
    if not isinstance(base, dict) or (now_ms - int(base.get("at") or 0)) > 86_400_000:
        base = estimate_base_overhead()
        state["baseSnapshot"] = base

    sess = state["sessions"].get(conv_id)
    if not isinstance(sess, dict):
        sess = {
            "id": conv_id,
            "startedAt": now_ms,
            "facts": empty_facts(),
            "epochFiles": [],
            "recentPrompts": [],
            "floor": int(base.get("total") or 25_000),
            "lastScannedOffset": 0,
            "lastCtx": int(base.get("total") or 25_000),
            "peakCtx": int(base.get("total") or 25_000),
            "pendingEvent": None,
        }
        state["sessions"][conv_id] = sess

    sync_from_transcript(sess, state, payload.get("transcriptPath"))
    ctx = int(sess.get("lastCtx") or base.get("total") or 25_000)

    if event_type == "SessionStart":
        bar_md = render_markdown_bar(ctx, HARD_LIMIT, sess, sess.get("pendingEvent"))
        sess["pendingEvent"] = None
        save_state(state)
        sys.stdout.write(
            json.dumps({
                "injectSteps": [
                    {
                        "systemMessage": {
                            "systemMessage": "",
                            "metadata": {"user_markdown": bar_md},
                        }
                    }
                ]
            })
            + "\n"
        )
        return

    if event_type == "PreInvocation":
        inv_num = int(payload.get("invocationNum") or 1)
        if inv_num > 1:
            save_state(state)
            sys.stdout.write("{}\n")
            return

        user_input = str(payload.get("lastUserInput") or "").strip()
        inject_steps: list[dict[str, Any]] = []

        if re.match(r"^/?longhaul(?:\s+health)?$", user_input, re.I):
            report = render_health_report(base, state["mcpCalls"])
            inject_steps.append({
                "ephemeralMessage": (
                    "The user asked for the longhaul report. Present this exact diagnostics report:\n\n"
                    + report
                )
            })

        facts = sess.get("facts") or empty_facts()
        task_done = is_task_done(facts)
        new_task = is_new_task(user_input, sess.get("recentPrompts") or []) if user_input else False
        floor = int(sess.get("floor") or base.get("total") or 25_000)
        over_soft = ctx >= max(SOFT_LIMIT, floor + MIN_GROWTH)
        over_hard = ctx >= HARD_LIMIT

        ev_line = sess.get("pendingEvent")
        sess["pendingEvent"] = None

        should_compact = over_hard or (over_soft and (task_done or new_task))
        if should_compact:
            reason = "hard-limit" if over_hard else ("task-done" if task_done else "new-task")
            instructions = build_compact_instructions(
                reason,
                sess.get("epochFiles") or [],
                bool(facts.get("committed")),
                bool(facts.get("testsPassed")),
                bool(facts.get("editedAfterTests")),
            )
            ev_line = (
                f"a good moment to compact ({math.floor(ctx / 1000)}k){SEP}"
                f"{REASON_LABEL[reason]}{SEP}run /compact"
            )
            inject_steps.append({
                "ephemeralMessage": (
                    f"longhaul smart compaction checkpoint ({REASON_LABEL[reason]}):\n"
                    f"{instructions}\n\n"
                    "Recommend the `/compact` command to the user once you finish answering."
                )
            })
            art_dir = payload.get("artifactDirectoryPath")
            if art_dir:
                try:
                    ap = Path(art_dir)
                    ap.mkdir(parents=True, exist_ok=True)
                    (ap / "longhaul-compaction-brief.md").write_text(
                        f"# longhaul compaction checkpoint ({REASON_LABEL[reason]})\n\n{instructions}\n",
                        encoding="utf-8",
                    )
                except OSError:
                    pass

        if user_input:
            recent = list(sess.get("recentPrompts") or [])
            recent.append(user_input)
            sess["recentPrompts"] = recent[-3:]
            if new_task or task_done:
                sess["epochFiles"] = []
            sess["facts"] = empty_facts()

            if classify_prompt(user_input) == "sonnet":
                inject_steps.append({"ephemeralMessage": AGY_HANDOFF})

        bar_md = render_markdown_bar(ctx, HARD_LIMIT, sess, ev_line)
        inject_steps.insert(
            0,
            {
                "systemMessage": {
                    "systemMessage": "",
                    "metadata": {"user_markdown": bar_md},
                }
            },
        )
        save_state(state)
        sys.stdout.write(json.dumps({"injectSteps": inject_steps}) + "\n")
        return

    save_state(state)
    sys.stdout.write("{}\n")


if __name__ == "__main__":
    main()
