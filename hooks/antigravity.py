#!/usr/bin/env python3
"""Antigravity lifecycle hook adapter for longhaul.

Tracks exact token counts (input_tokens + cache_read_tokens), compactions, MCP
usage, and verification state incrementally from Antigravity's transcript.jsonl.
Classifies prompts in English and Spanish for subagent delegation, triggers
state-aware smart compaction checkpoints, and serves `longhaul` / `longhaul health`
diagnostics without storing raw prompt or command text on disk.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

SEP = " · "
SOFT_LIMIT = int(os.environ.get("LONGHAUL_SOFT_LIMIT", "150000"))
HARD_LIMIT = int(os.environ.get("LONGHAUL_HARD_LIMIT", "300000"))
MIN_GROWTH = 50_000
DAY_MS = 86_400_000
RETENTION_MS = 21 * DAY_MS
MIN_HISTORY_MS = 3 * DAY_MS
SNAPSHOT_VERSION = 2
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

REASON_LABEL = {
    "task-done": "task finished",
    "new-task": "new task",
    "hard-limit": "hard limit",
    "manual": "/compact",
    "auto": "auto-compact",
}

KEEP_LIST = (
    "Keep, in this order: the current plan and its next step; the decisions made "
    "and why; the files touched; open items and failing tests; anything the user "
    "corrected or asked for in this session."
)

DROP_LIST = (
    "Drop raw tool outputs, file contents that can be re-read from disk, resolved "
    "errors, dead-end explorations, and play-by-play narration of completed steps."
)

AGY_HANDOFF = (
    "longhaul: this looks like execution work. Delegate it to a lighter subagent "
    'via invoke_subagent (TypeName: "self" or "research", Model: "flash") with a '
    "short brief (goal, files, how to check it), then review its changes and test "
    "results before accepting."
)

LIGHT_MODEL_TOKENS = ("flash", "lite", "haiku", "sonnet", "nano")

COMMIT_RE = re.compile(
    r"\b(?:git(?:\.exe)?\s+(?:-C\s+\S+\s+)?commit\b(?!.*--dry-run)|gh(?:\.exe)?\s+pr\s+(?:create|merge)\b)"
)
TEST_RE = re.compile(
    r"\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|"
    r"(?:npx|bunx|pnpm(?:\s+exec)?|yarn)\s+(?:vitest|jest|playwright)|"
    r"vitest|jest|(?:uv\s+run\s+|python3?\s+-m\s+)?(?:pytest|unittest)\b|"
    r"cargo\s+test|go\s+test|claude\s+plugin\s+test)\b"
)
EXIT_NONZERO_RE = re.compile(r"Command exited with code [1-9]\d*")
BG_START_RE = re.compile(r"task id:\s*(\S+)", re.I)
BG_DONE_RE = re.compile(r'Task id "([^"]+)" finished with result:')
CMD_STATUS_RE = re.compile(r"^/?longhaul(?:\s+(?:status|report))?$", re.I)
CMD_HEALTH_RE = re.compile(r"^/?longhaul\s+health$", re.I)

REF_RE = re.compile(r"#(\d{2,})\b|\b(?:pr|issue)\s*#?\s*(\d+)|/(?:pull|issues)/(\d+)", re.I)
CSS_CONTEXT_RE = re.compile(
    r"\b(?:colou?r|background|border|fill|stroke|shadow|hex|css|font|padding|margin)\b",
    re.I,
)

NEW_TASK_PHRASES = [
    re.compile(r"\bwhat(?:'?s| is) next\b"),
    re.compile(r"\bnow let'?s\b"),
    re.compile(r"^(?:now|next)\s+(?:can you|please|we need to|i want to)\b"),
    re.compile(r"\b(?:another thing|new task|moving on|switching gears|different topic|unrelated|separate question)\b"),
    re.compile(r"^(?:the )?next task\b"),
    re.compile(r"^(?:done with that|that'?s done|ok great\s*,?\s*now|great\s*,?\s*now)\b"),
    re.compile(r"^(?:y ahora )?que sigue\b"),
    re.compile(r"^(?:ahora|siguiente)\s+(?:vamos a|hay que|quiero|puedes|toca)\b"),
    re.compile(r"\b(?:otra cosa|nueva tarea|cambiando de tema|por otro lado|aparte de eso)\b"),
    re.compile(r"^(?:la )?siguiente tarea\b"),
    re.compile(r"^(?:listo con eso|ya quedo\s*,?\s*ahora|perfecto\s*,?\s*ahora vamos)\b"),
]

STOPWORDS = {
    "the", "a", "an", "to", "in", "on", "of", "for", "and", "or", "is", "it",
    "this", "that", "with", "from", "by", "at", "be", "as", "are", "was", "were",
    "can", "you", "please", "lets", "let", "now", "we", "i", "my", "me", "do",
    "el", "la", "los", "las", "un", "una", "de", "del", "en", "y", "o", "que",
    "es", "por", "para", "con", "se", "al", "como", "mas", "pero", "su", "le",
    "ya", "si", "sin", "sobre", "este", "esta", "esto", "eso", "vamos",
}

_DATA_EN = r"data|database|db|tables?|migrations?|records?|rows?|users?|backups?|prod|production|branch(?:es)?|history"
_STEP_EN = r"go with|start|do|run|execute|implement|continue with|proceed with"

DEFAULT_OPUS_PATTERNS = [
    re.compile(r"\b(?:design|architect(?:ure)?|trade-?offs?|brainstorm\w*)\b", re.I),
    re.compile(
        r"\b(?:should (?:we|i)|which (?:is )?(?:better|best)|best way|most professional|"
        r"pros and cons|most natural|best (?:approach|option|solution|practice)|compare\s+.+\s+vs)\b",
        re.I,
    ),
    re.compile(r"\b(?:why|root cause|investigate|diagnose|intermittent|flaky|race condition|deadlock|memory leak)\b", re.I),
    re.compile(r"\b(?:review|audit|critique|threat model)\b", re.I),
    re.compile(r"\b(?:write|draft|create|make|outline)\b.{0,30}\b(?:plan|spec|rfc|design doc)\b", re.I),
    re.compile(r"\b(?:security|vulnerabilit\w+|exploit|xss|csrf|secrets?|credentials?)\b", re.I),
    re.compile(r"\b(?:payments?|billing|invoices?|stripe|refunds?|checkout)\b", re.I),
    re.compile(r"\b(?:auth|authentication|authorization|oauth|passwords?|jwt)\b", re.I),
    re.compile(rf"\b(?:delete|drop|wipe|purge|truncate|remove)\b.{{0,40}}\b(?:{_DATA_EN})\b", re.I),
    # Spanish
    re.compile(r"\b(?:dise[ñn][oa]r?|arquitectura|brainstorm\w*|lluvia de ideas|pros y contras)\b", re.I),
    re.compile(
        r"\b(?:cu[aá]l (?:ser[ií]a|es (?:la|el) (?:mejor|forma|manera))|deber[ií]amos|"
        r"(?:la )?mejor (?:forma|manera)|(?:lo )?m[aá]s profesional|qu[eé] opinas|siguiente paso m[aá]s natural)\b",
        re.I,
    ),
    re.compile(r"\b(?:por qu[eé]|causa ra[ií]z|intermitente|investiga|diagnostica)\b", re.I),
    re.compile(r"\b(?:revisa|revisar|revisi[oó]n|audita|auditar|critica)\b", re.I),
    re.compile(r"\b(?:escribe|redacta|crea|haz|arma)\b.{0,30}\b(?:plan|spec|especificaci[oó]n)\b", re.I),
    re.compile(r"\b(?:seguridad|vulnerabilidad\w*|credenciales|secretos?)\b", re.I),
    re.compile(r"\b(?:pagos?|facturaci[oó]n|facturas?|reembolsos?)\b", re.I),
    re.compile(r"\b(?:autenticaci[oó]n|autorizaci[oó]n|contrase[ñn]as?)\b", re.I),
    re.compile(
        r"\b(?:borra|borrar|elimina|eliminar|bota)\b.{0,40}\b"
        r"(?:datos|base de datos|tablas?|migraciones|registros|usuarios|respaldos?|backups?|producci[oó]n|historial)\b",
        re.I,
    ),
]

DEFAULT_SONNET_PATTERNS = [
    re.compile(rf"\b(?:{_STEP_EN})\s+(?:the\s+)?(?:next\s+)?(?:task|step|phase|milestone)(?:\s*#?\d+)?\b|\b(?:{_STEP_EN})\s+[a-z]\d+\b", re.I),
    re.compile(r"\b(?:rename\s+\S+\s+to\s+\S+|reformat|find and replace|search and replace|bulk (?:rename|replace|edit)|update snapshots?|bump version)\b", re.I),
    re.compile(r"^\s*(?:where is|where's|where are|find|locate|search for|list all|grep)\b", re.I),
    re.compile(r"\b(?:add (?:jsdoc|docstrings?|comments?) to|document (?:this|the) (?:code|function|module)|generate (?:the )?(?:docs|readme))\b", re.I),
    re.compile(r"\b(?:fix\b.{0,25}\b(?:lint|type|typescript|eslint|tsc|import|formatting)\b)\b", re.I),
    re.compile(r"\b(?:run (?:the )?(?:tests?|test suite|lint|linter|build|typecheck))\b", re.I),
    # Spanish
    re.compile(
        r"\b(?:(?:ejecuta|arranca|empieza|sigue|implementa|vamos|dale)\s+(?:con\s+)?"
        r"(?:(?:el|la|la siguiente|el siguiente)\s+)?(?:hito|tarea|paso|etapa)(?:\s*#?\d+)?|"
        r"(?:arranca|empieza|vamos|dale)\s+con\s+[a-z]\d+)\b",
        re.I,
    ),
    re.compile(r"\b(?:renombra\s+\S+\s+(?:a|como)\s+\S+|reformatea|busca y reemplaza)\b", re.I),
    re.compile(r"^\s*(?:d[oó]nde (?:est[aá]n?|queda|se define)|busca|encuentra|localiza)\b", re.I),
    re.compile(r"\b(?:documenta (?:esto|el c[oó]digo|la funci[oó]n)|genera (?:la )?(?:documentaci[oó]n|readme))\b", re.I),
    re.compile(r"\b(?:arregla\b.{0,25}\b(?:lint|tipos|eslint|tsc))\b", re.I),
    re.compile(r"\b(?:corre (?:las )?pruebas|ejecuta (?:las )?(?:pruebas|tests))\b", re.I),
]


def state_path() -> Path:
    override = os.environ.get("LONGHAUL_AGY_STATE")
    if override:
        return Path(override)
    legacy = Path.home() / ".cache" / "longhaul-antigravity-state.json"
    plugin_data = os.environ.get("PLUGIN_DATA")
    if plugin_data:
        pdata_state = Path(plugin_data) / "state.json"
        if pdata_state.exists() or not legacy.exists():
            return pdata_state
    return legacy


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


def short_hash(token: str) -> str:
    return hashlib.blake2s(token.encode("utf-8", errors="ignore"), digest_size=4).hexdigest()


def norm_text(text: str) -> str:
    s = text.replace("\u2018", "'").replace("\u2019", "'").lower()
    out: list[str] = []
    for ch in unicodedata.normalize("NFD", s):
        if ch == "\u0303":  # preserve ñ tilde
            out.append(ch)
        elif unicodedata.category(ch) != "Mn":
            out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))


def extract_refs(text: str) -> set[str]:
    is_css = bool(CSS_CONTEXT_RE.search(text))
    found: set[str] = set()
    for m in REF_RE.finditer(text):
        g1, g2, g3 = m.group(1), m.group(2), m.group(3)
        if g1 and len(g1) in (3, 6) and is_css:
            continue
        ref = g1 or g2 or g3
        if ref:
            found.add(ref)
    return found


def content_words(text: str) -> set[str]:
    words = re.findall(r"[a-zñ0-9_]{3,}", norm_text(text))
    return {w for w in words if w not in STOPWORDS}


def prompt_fingerprint(prompt: str) -> dict[str, list[str]]:
    w_hashes = sorted(short_hash(w) for w in content_words(prompt))[:60]
    r_hashes = sorted(short_hash(r) for r in extract_refs(prompt))[:12]
    return {"w": w_hashes, "r": r_hashes}


def is_new_task(prompt: str, recent_fps: list[dict[str, Any]]) -> bool:
    trimmed = prompt.strip()
    if not trimmed:
        return False
    normed = norm_text(trimmed)
    if any(pat.search(normed) for pat in NEW_TASK_PHRASES):
        return True
    if not recent_fps:
        return False

    seen_refs = {r for fp in recent_fps for r in (fp.get("r") or [])}
    cur_refs = {short_hash(r) for r in extract_refs(trimmed)}
    if seen_refs and any(r not in seen_refs for r in cur_refs):
        return True

    cur_w = {short_hash(w) for w in content_words(trimmed)}
    if len(cur_w) < 5:
        return False
    comparable = [set(fp.get("w") or []) for fp in recent_fps if len(fp.get("w") or []) >= 5]
    if not comparable:
        return False
    return all((len(cur_w & prev_w) / len(cur_w | prev_w)) < 0.1 for prev_w in comparable)


def load_custom_rules() -> list[tuple[str, re.Pattern[str]]] | None:
    rules_path = os.environ.get("LONGHAUL_RULES_FILE", "").strip()
    if not rules_path:
        return None
    try:
        raw = json.loads(Path(rules_path).read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            return None
        compiled: list[tuple[str, re.Pattern[str]]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            verdict = item.get("verdict")
            pattern = item.get("pattern")
            if verdict not in ("opus", "sonnet") or not isinstance(pattern, str):
                continue
            flags_str = str(item.get("flags") or "i")
            flags = re.I if "i" in flags_str else 0
            if "m" in flags_str:
                flags |= re.M
            if "s" in flags_str:
                flags |= re.S
            try:
                compiled.append((verdict, re.compile(pattern, flags)))
            except re.error:
                continue
        return compiled or None
    except Exception:
        return None


def classify_prompt(prompt: str) -> str:
    text = prompt.strip()
    if len(text) < 8:
        return "neutral"
    custom = load_custom_rules()
    if custom is not None:
        for verdict, pat in custom:
            if verdict == "opus" and pat.search(text):
                return "opus"
        for verdict, pat in custom:
            if verdict == "sonnet" and pat.search(text):
                return "sonnet"
        return "neutral"

    for pat in DEFAULT_OPUS_PATTERNS:
        if pat.search(text):
            return "opus"
    for pat in DEFAULT_SONNET_PATTERNS:
        if pat.search(text):
            return "sonnet"
    return "neutral"


def is_light_model(model_name: str) -> bool:
    low = model_name.lower()
    return any(tok in low for tok in LIGHT_MODEL_TOKENS)


def summarize_tool_call(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Extract privacy-safe tool metadata without retaining raw command text."""
    if tool in ("edit_file", "write_file", "Edit", "Write", "MultiEdit"):
        path = strip_quotes(args.get("Path") or args.get("file_path") or "")
        return {"tool": tool, "path": path}
    if tool in ("run_command", "Bash"):
        cmd = strip_quotes(args.get("CommandLine") or args.get("command") or "")
        return {
            "tool": tool,
            "isCommit": bool(COMMIT_RE.search(cmd)),
            "isTest": bool(TEST_RE.search(cmd)),
        }
    return {"tool": tool}


def observe_tool_summary(facts: dict[str, Any], meta: dict[str, Any], is_error: bool) -> dict[str, Any]:
    edited = list(facts.get("editedFiles") or [])
    committed = bool(facts.get("committed"))
    tests_passed = bool(facts.get("testsPassed"))
    edited_after_tests = bool(facts.get("editedAfterTests"))

    tool = str(meta.get("tool") or "")
    if tool in ("edit_file", "write_file", "Edit", "Write", "MultiEdit"):
        if not is_error:
            p = str(meta.get("path") or "")
            if p and p not in edited:
                edited.append(p)
            if tests_passed:
                edited_after_tests = True
            committed = False
    elif tool in ("run_command", "Bash"):
        if not is_error and meta.get("isCommit"):
            committed = True
        if meta.get("isTest"):
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


def observe_tool(facts: dict[str, Any], tool: str, args: dict[str, Any], is_error: bool) -> dict[str, Any]:
    return observe_tool_summary(facts, summarize_tool_call(tool, args), is_error)


def is_task_done(facts: dict[str, Any]) -> bool:
    if facts.get("committed"):
        return True
    if facts.get("testsPassed") and not facts.get("editedAfterTests"):
        return True
    return False


def build_compact_instructions(
    reason: str | None,
    edited_files: list[str],
    committed: bool,
    tests_passed: bool,
    edited_after_tests: bool,
) -> str:
    dedup_files = list(dict.fromkeys(f for f in edited_files if f))
    has_facts = bool(dedup_files) or committed or tests_passed
    if not has_facts and reason not in ("task-done", "new-task", "hard-limit"):
        return KEEP_LIST

    parts: list[str] = []
    if reason in ("task-done", "new-task"):
        parts.append(
            "The previous task reached a clean boundary: collapse its finished work "
            "to a concise outcome record and drop step-by-step tool transcripts."
        )
    elif reason == "hard-limit":
        parts.append(
            "Mid-task compaction at the context limit: preserve the active hypothesis, "
            "the latest error or failing check, and the immediate next edit."
        )

    state_items: list[str] = []
    if dedup_files:
        shown = dedup_files[:25]
        more = f" (+{len(dedup_files) - 25} more)" if len(dedup_files) > 25 else ""
        state_items.append(f"files edited ({', '.join(shown)}{more})")
    if committed:
        state_items.append("changes committed")
    if tests_passed and not edited_after_tests:
        state_items.append("tests passing")
    elif tests_passed and edited_after_tests:
        state_items.append("files edited since last passing test run")
    if state_items:
        parts.append(f"Session state: {'; '.join(state_items)}.")

    parts.append(DROP_LIST)
    parts.append(KEEP_LIST)
    return "\n\n".join(parts)


def bar_str(r: float, width: int = 8) -> str:
    clamped = max(0.0, min(1.0, r))
    n = max(0, min(width, round(clamped * width)))
    return "▰" * n + "▱" * (width - n)


def fmt_k(n: int) -> str:
    return f"{max(0, round(n / 1000))}k"


def fmt_int(n: int) -> str:
    return f"{round(n):,}"


def bucket_of(ctx: int) -> str:
    if ctx < 100_000:
        return "lt100k"
    if ctx < 200_000:
        return "100to200k"
    if ctx < 400_000:
        return "200to400k"
    return "gt400k"


def render_markdown_bar(ctx: int, hard: int, sess: dict[str, Any], event_line: str | None = None) -> str:
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


def candidate_roots(workspace_paths: list[str] | None = None) -> list[Path]:
    raw_candidates: list[Path] = [Path.home()]
    if workspace_paths:
        for wp in workspace_paths:
            if wp:
                raw_candidates.append(Path(wp))
    else:
        try:
            raw_candidates.append(Path.cwd())
        except OSError:
            pass

    for cand in tuple(raw_candidates):
        for p in (cand, *cand.parents):
            parts = p.parts
            if len(parts) == 5 and parts[0] == "/" and parts[1] == "mnt" and len(parts[2]) == 1 and parts[3].lower() == "users":
                raw_candidates.append(p)
                break

    roots: list[Path] = []
    seen: set[str] = set()
    for cand in raw_candidates:
        key = str(cand)
        if key not in seen and cand.exists():
            seen.add(key)
            roots.append(cand)
    return roots


def find_duplicates(files: list[tuple[str, str]]) -> dict[str, Any]:
    seen: dict[str, set[str]] = {}
    for path_str, text in files:
        for raw in text.splitlines():
            collapsed = re.sub(r"\s+", " ", raw.strip())
            if len(collapsed) < 40 or not re.search(r"[a-zA-Z0-9]", collapsed):
                continue
            seen.setdefault(collapsed, set()).add(path_str)
    chars = 0
    lines = 0
    dup_paths: set[str] = set()
    for line_text, paths in seen.items():
        if len(paths) < 2:
            continue
        lines += 1
        chars += (len(paths) - 1) * len(line_text)
        dup_paths.update(paths)
    ordered = [p for p, _ in files if p in dup_paths]
    return {"lines": lines, "tokens": round(chars / 4), "files": ordered}


def estimate_base_overhead(workspace_paths: list[str] | None = None) -> dict[str, Any]:
    app_data = Path(os.environ.get("AGY_APP_DATA_DIR") or (Path.home() / ".gemini" / "antigravity-cli"))
    mcp_dir = app_data / "mcp"
    if not mcp_dir.is_dir():
        alt = Path.home() / ".gemini" / "antigravity" / "mcp"
        if alt.is_dir():
            mcp_dir = alt

    mcp_index_tokens = 0
    mcp_by_server: dict[str, dict[str, int]] = {}
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
            idx_toks = (12 + count * 4) if count else 0
            schema_toks = round(chars / 4)
            mcp_index_tokens += idx_toks
            mcp_by_server[srv.name] = {
                "tools": count,
                "tokens": idx_toks,
                "schemaTokens": schema_toks,
            }

    roots = candidate_roots(workspace_paths)
    mem_tokens = 0
    memory: list[dict[str, Any]] = []
    scanned_texts: list[tuple[str, str]] = []
    seen_mem: set[str] = set()
    rel_mem_paths = (
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/AGENTS.md",
        ".claude/CLAUDE.md",
        ".gemini/GEMINI.md",
    )
    for root in roots:
        for rel in rel_mem_paths:
            p = root / rel
            p_key = str(p)
            if p_key in seen_mem or not p.is_file():
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            seen_mem.add(p_key)
            rows = text.splitlines()
            toks = round(len(text) / 4)
            mem_tokens += toks
            memory.append({"path": p_key, "tokens": toks, "lines": len(rows)})
            if len(text) <= 1_000_000:
                scanned_texts.append((p_key, text))

    skill_names: set[str] = set()
    skill_dirs = [app_data / "builtin" / "skills"] + [r / ".agents" / "skills" for r in roots] + [r / ".gemini" / "skills" for r in roots]
    seen_skill_dirs: set[str] = set()
    for sdir in skill_dirs:
        s_key = str(sdir)
        if s_key in seen_skill_dirs or not sdir.is_dir():
            continue
        seen_skill_dirs.add(s_key)
        try:
            with os.scandir(sdir) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                        skill_names.add(entry.name)
        except OSError:
            pass

    skill_count = len(skill_names)
    skill_tokens = skill_count * 110
    core_prompt_tokens = 12_500
    total = core_prompt_tokens + mcp_index_tokens + mem_tokens + skill_tokens
    return {
        "version": SNAPSHOT_VERSION,
        "at": int(time.time() * 1000),
        "total": total,
        "mcp": mcp_by_server,
        "memory": memory,
        "skills": {"count": skill_count, "tokens": skill_tokens},
        "duplicate": find_duplicates(scanned_texts),
    }


def heal_and_prune_state(state: dict[str, Any], now_ms: int) -> None:
    state.setdefault("mcpCalls", {})
    state.setdefault("startedAt", now_ms)
    sessions = state.get("sessions")
    if not isinstance(sessions, dict):
        state["sessions"] = {}
        return

    to_delete: list[str] = []
    for sid, sess in sessions.items():
        if not isinstance(sess, dict):
            to_delete.append(sid)
            continue
        last_seen = int(sess.get("updatedAt") or sess.get("startedAt") or now_ms)
        if (now_ms - last_seen) > RETENTION_MS:
            to_delete.append(sid)
            continue

        # Migrate any legacy raw prompts to privacy-safe short hashes and drop raw text.
        legacy_prompts = sess.pop("recentPrompts", None)
        if isinstance(legacy_prompts, list) and "recentFingerprints" not in sess:
            sess["recentFingerprints"] = [
                prompt_fingerprint(str(p)) for p in legacy_prompts[-3:] if isinstance(p, str) and p.strip()
            ]
        sess.pop("pendingEvent", None)

        # Heal legacy v1 242k baseSnapshot poisoning on sessions that never hit 240k in reality.
        comp_log = sess.get("compactionLog") or []
        last_ctx = int(sess.get("lastCtx") or 0)
        peak_ctx = int(sess.get("peakCtx") or 0)
        floor_ctx = int(sess.get("floor") or 0)
        if not comp_log and peak_ctx >= 240_000 and last_ctx < 240_000:
            sess["peakCtx"] = last_ctx
        if not comp_log and floor_ctx >= 240_000 and last_ctx < floor_ctx:
            sess["floor"] = min(last_ctx, 30_000) if last_ctx > 0 else 0
        if last_ctx >= 240_000 and not comp_log and peak_ctx == 242_699 and last_ctx == 242_699:
            sess["lastCtx"] = 0
            sess["peakCtx"] = 0
            sess["floor"] = 0

    for sid in to_delete:
        sessions.pop(sid, None)


def load_state(now_ms: int | None = None) -> dict[str, Any]:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    try:
        data = json.loads(state_path().read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("invalid state root")
    except Exception:
        data = {"sessions": {}, "mcpCalls": {}, "startedAt": now}
    heal_and_prune_state(data, now)
    return data


def save_state(state: dict[str, Any]) -> None:
    p = state_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(state), encoding="utf-8")
    except Exception:
        pass


def record_epoch_files(sess: dict[str, Any]) -> None:
    epoch_files = sess.setdefault("epochFiles", [])
    for ef in (sess.get("facts") or {}).get("editedFiles") or []:
        if ef and ef not in epoch_files:
            epoch_files.append(ef)


def sync_from_transcript(
    sess: dict[str, Any],
    state: dict[str, Any],
    transcript_path: str | None,
    now_ms: int | None = None,
) -> None:
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
        sess["pendingTools"] = []
    if size == offset:
        return

    try:
        with p.open("rb") as f:
            f.seek(offset)
            raw_bytes = f.read()
            new_offset = f.tell()
    except OSError:
        return

    now = now_ms if now_ms is not None else int(time.time() * 1000)
    sess["lastScannedOffset"] = new_offset
    sess["updatedAt"] = now

    pending_tools: list[dict[str, Any]] = list(sess.get("pendingTools") or [])
    pending_bg: dict[str, dict[str, Any]] = dict(sess.get("pendingBgTasks") or {})

    for raw_line in raw_bytes.decode("utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            step = json.loads(line)
        except Exception:
            continue

        step_type = step.get("type")
        if step_type == "USER_INPUT":
            sess["lastTriggerType"] = "USER_INPUT"

        elif step_type == "SYSTEM_MESSAGE":
            sess["lastTriggerType"] = "SYSTEM_MESSAGE"
            content = str(step.get("content") or "")
            m_done = BG_DONE_RE.search(content)
            if m_done:
                task_id = m_done.group(1).strip()
                bg_meta = pending_bg.pop(task_id, None)
                if isinstance(bg_meta, dict):
                    is_err = "Command exited with code 0" not in content
                    sess["facts"] = observe_tool_summary(sess.get("facts") or empty_facts(), bg_meta, is_err)
                    record_epoch_files(sess)

        elif step_type == "CHECKPOINT":
            sess["lastTriggerType"] = "CHECKPOINT"
            chk_ctx = int(step.get("input_tokens") or 0) + int(step.get("cache_read_tokens") or 0)
            before_ctx = max(int(sess.get("lastCtx") or 0), chk_ctx)
            if before_ctx > 0:
                sess["pendingCompactionBefore"] = before_ctx
            sess["epochFiles"] = []
            sess["facts"] = empty_facts()
            sess["lastCompactNudgeCtx"] = 0

        elif step_type == "PLANNER_RESPONSE":
            in_tok = int(step.get("input_tokens") or 0)
            cache_tok = int(step.get("cache_read_tokens") or 0)
            out_tok = int(step.get("output_tokens") or 0)
            step_ctx = in_tok + cache_tok

            sess["steps"] = int(sess.get("steps") or 0) + 1
            toks = sess.setdefault("tokens", {"input": 0, "cacheRead": 0, "output": 0})
            toks["input"] = int(toks.get("input") or 0) + in_tok
            toks["cacheRead"] = int(toks.get("cacheRead") or 0) + cache_tok
            toks["output"] = int(toks.get("output") or 0) + out_tok

            if step_ctx > 0:
                buckets = sess.setdefault(
                    "byBucket",
                    {"lt100k": 0, "100to200k": 0, "200to400k": 0, "gt400k": 0},
                )
                b_key = bucket_of(step_ctx)
                buckets[b_key] = int(buckets.get(b_key) or 0) + step_ctx

                prev_ctx = int(sess.get("lastCtx") or 0)
                pending_before = int(sess.pop("pendingCompactionBefore", 0) or 0)
                ref_before = pending_before or prev_ctx

                if prev_ctx == 0 and pending_before == 0:
                    if int(sess.get("floor") or 0) == 0:
                        sess["floor"] = step_ctx
                elif pending_before > 0 or (ref_before - step_ctx) >= 25_000:
                    reason = str(sess.pop("lastCompactReason", "") or "auto")
                    comp_log = list(sess.get("compactionLog") or [])
                    comp_log.append({
                        "at": now,
                        "before": ref_before,
                        "after": step_ctx,
                        "reason": reason,
                    })
                    sess["compactionLog"] = comp_log[-50:]
                    sess["floor"] = step_ctx
                    sess["epochFiles"] = []
                    sess["facts"] = empty_facts()
                    sess["lastCompactNudgeCtx"] = 0

                sess["lastCtx"] = step_ctx
                sess["peakCtx"] = max(int(sess.get("peakCtx") or 0), step_ctx)

            pending_tools.clear()
            for tc in step.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                t_name = str(tc.get("name") or "")
                t_args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                pending_tools.append(summarize_tool_call(t_name, t_args))
                if t_name == "call_mcp_tool":
                    srv = strip_quotes(t_args.get("ServerName") or "")
                    if srv:
                        state["mcpCalls"][srv] = int(state["mcpCalls"].get(srv) or 0) + 1
                        sess_mcp = sess.setdefault("mcpCalls", {})
                        sess_mcp[srv] = int(sess_mcp.get(srv) or 0) + 1

        elif step_type == "GENERIC" and pending_tools:
            meta = pending_tools.pop(0)
            content = str(step.get("content") or "")
            status = str(step.get("status") or "")
            if status == "RUNNING":
                m_bg = BG_START_RE.search(content)
                if m_bg:
                    pending_bg[m_bg.group(1).strip()] = meta
                    if len(pending_bg) > 30:
                        oldest = next(iter(pending_bg))
                        pending_bg.pop(oldest, None)
            else:
                is_err = status == "ERROR" or bool(EXIT_NONZERO_RE.search(content))
                sess["facts"] = observe_tool_summary(sess.get("facts") or empty_facts(), meta, is_err)
                record_epoch_files(sess)

    sess["pendingTools"] = pending_tools[-20:]
    sess["pendingBgTasks"] = pending_bg


def format_stamp(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000)
    return f"{WEEKDAYS[dt.weekday()]} {dt.strftime('%H:%M')}"


def render_health_report(base: dict[str, Any], mcp_calls: dict[str, int], state: dict[str, Any]) -> str:
    now_ms = int(time.time() * 1000)
    started_at = int(state.get("startedAt") or now_ms)
    mature = (now_ms - started_at) >= MIN_HISTORY_MS
    since_date = datetime.fromtimestamp(started_at / 1000).strftime("%Y-%m-%d")

    items: list[tuple[int, str]] = []
    advice: list[tuple[int, str]] = []

    for srv, info in (base.get("mcp") or {}).items():
        tools = int(info.get("tools") or 0)
        idx_toks = int(info.get("tokens") or 0)
        schema_toks = int(info.get("schemaTokens") or 0)
        calls = int(mcp_calls.get(srv) or 0)
        usage_note = (
            f"used ({calls} calls)"
            if calls > 0
            else (f"no calls recorded since {since_date}" if not mature else "not used this week")
        )
        schema_part = f", ~{fmt_k(schema_toks)} lazy schemas on disk" if schema_toks else ""
        items.append((
            idx_toks,
            f"{srv} MCP: {tools} tool{'' if tools == 1 else 's'}, {fmt_int(idx_toks)} index tokens (est.{schema_part}), {usage_note}",
        ))
        if mature and calls == 0 and idx_toks > 0:
            advice.append((
                idx_toks,
                f"{srv} has {tools} tool{'' if tools == 1 else 's'} (~{fmt_int(idx_toks)} index tokens in every turn) and was not used: disable it where not needed.",
            ))

    for m in base.get("memory") or []:
        toks = int(m.get("tokens") or 0)
        lines_n = int(m.get("lines") or 0)
        items.append((toks, f"{m['path']}: {lines_n} lines, {fmt_int(toks)} tokens (est.)"))
        if lines_n > 200 or toks > 3000:
            advice.append((
                toks,
                f"{m['path']} is {lines_n} lines (~{fmt_int(toks)} tokens): shorten it or split project-specific rules.",
            ))

    skills = base.get("skills") or {}
    if skills.get("count"):
        s_toks = int(skills.get("tokens") or 0)
        items.append((s_toks, f"skills index: {skills['count']} listed, {fmt_int(s_toks)} tokens (est.)"))

    dup = base.get("duplicate") or {}
    if int(dup.get("lines") or 0) > 0:
        d_toks = int(dup.get("tokens") or 0)
        d_files = dup.get("files") or []
        items.append((d_toks, f"repeated text: {dup['lines']} lines across {len(d_files)} files, {fmt_int(d_toks)} tokens (est.)"))
        if d_toks >= 500:
            advice.append((
                d_toks,
                f"About {fmt_int(d_toks)} tokens are repeated across {', '.join(d_files)}: keep shared rules in one file.",
            ))

    items.sort(key=lambda x: -x[0])
    advice.sort(key=lambda x: -x[0])
    if not advice:
        advice.append((0, "Your sessions start light."))

    lines = [
        "Context health (Antigravity)",
        "",
        f"Sessions start at ~{fmt_int(int(base.get('total') or 0))} tokens (est.). What loads before any work:",
        *(f"- {text}" for _, text in items),
        "",
        "Advice",
        *(f"- {text}" for _, text in advice),
    ]
    return "\n".join(lines)


def render_status_report(sess: dict[str, Any], state: dict[str, Any], base: dict[str, Any]) -> str:
    now_ms = int(time.time() * 1000)
    ctx = int(sess.get("lastCtx") or base.get("total") or 0)
    floor = int(sess.get("floor") or ctx)
    peak = max(int(sess.get("peakCtx") or 0), ctx)
    steps = int(sess.get("steps") or 0)
    comp_log = sess.get("compactionLog") or []
    facts = sess.get("facts") or empty_facts()
    epoch_files = sess.get("epochFiles") or []

    bar = render_markdown_bar(ctx, HARD_LIMIT, sess)
    status_bits = [f"step {steps}", f"floor {fmt_k(floor)}", f"peak {fmt_k(peak)}"]
    if comp_log:
        status_bits.append(f"{len(comp_log)} compaction{'' if len(comp_log) == 1 else 's'}")

    lines = [
        "longhaul report (Antigravity)",
        "",
        bar,
        f"  {SEP.join(status_bits)} · soft {fmt_k(SOFT_LIMIT)} · hard {fmt_k(HARD_LIMIT)}",
    ]
    if epoch_files:
        shown = [Path(f).name for f in epoch_files[:8]]
        more = f" (+{len(epoch_files) - 8} more)" if len(epoch_files) > 8 else ""
        lines.append(f"  epoch files: {', '.join(shown)}{more}")
    if facts.get("committed"):
        lines.append("  verification: changes committed")
    elif facts.get("testsPassed") and not facts.get("editedAfterTests"):
        lines.append("  verification: tests passing")
    elif facts.get("testsPassed") and facts.get("editedAfterTests"):
        lines.append("  verification: edited since last passing test run")

    week_cutoff = now_ms - 7 * DAY_MS
    sessions = [
        s for s in (state.get("sessions") or {}).values()
        if isinstance(s, dict) and int(s.get("updatedAt") or s.get("startedAt") or 0) >= week_cutoff
    ]

    tot_in = sum(int((s.get("tokens") or {}).get("input") or 0) for s in sessions)
    tot_read = sum(int((s.get("tokens") or {}).get("cacheRead") or 0) for s in sessions)
    tot_out = sum(int((s.get("tokens") or {}).get("output") or 0) for s in sessions)
    tot_all = tot_in + tot_read + tot_out

    lines.extend(["", f"Last 7 days ({len(sessions)} session{'' if len(sessions) == 1 else 's'})"])
    if tot_all > 0:
        pct_read = round((tot_read / tot_all) * 100)
        pct_in = round((tot_in / tot_all) * 100)
        pct_out = max(0, 100 - pct_read - pct_in)
        lines.append(f"- {pct_read}% cache reads ({fmt_k(tot_read)}) · {pct_in}% fresh input ({fmt_k(tot_in)}) · {pct_out}% output ({fmt_k(tot_out)})")

    buckets = {"lt100k": 0, "100to200k": 0, "200to400k": 0, "gt400k": 0}
    for s in sessions:
        sb = s.get("byBucket") or {}
        for k in buckets:
            buckets[k] += int(sb.get(k) or 0)
    b_sum = sum(buckets.values())
    if b_sum > 0:
        lines.append(
            "- context volume: "
            f"{round(buckets['lt100k'] * 100 / b_sum)}% <100k · "
            f"{round(buckets['100to200k'] * 100 / b_sum)}% 100-200k · "
            f"{round(buckets['200to400k'] * 100 / b_sum)}% 200-400k · "
            f"{round(buckets['gt400k'] * 100 / b_sum)}% >400k"
        )

    top = sorted(
        sessions,
        key=lambda s: (
            int((s.get("tokens") or {}).get("cacheRead") or 0) + int((s.get("tokens") or {}).get("input") or 0),
            int(s.get("peakCtx") or 0),
        ),
        reverse=True,
    )[:5]
    if top:
        lines.extend(["", "Biggest sessions"])
        for s in top:
            sid = str(s.get("id") or "")[:8]
            proj = str(s.get("project") or sid)
            s_steps = int(s.get("steps") or 0)
            s_peak = int(s.get("peakCtx") or s.get("lastCtx") or 0)
            s_comp = len(s.get("compactionLog") or [])
            s_at = int(s.get("startedAt") or now_ms)
            lines.append(
                f"- {proj} ({sid}){SEP}{format_stamp(s_at)}{SEP}"
                f"{s_steps} step{'' if s_steps == 1 else 's'}{SEP}"
                f"peak {fmt_k(s_peak)}{SEP}{s_comp} compaction{'' if s_comp == 1 else 's'}"
            )

    all_comps = [c for s in sessions for c in (s.get("compactionLog") or []) if isinstance(c, dict)]
    lines.extend(["", "Compactions"])
    if not all_comps:
        lines.append("  No compactions recorded yet.")
    else:
        by_reason: dict[str, int] = {}
        for c in all_comps:
            r = str(c.get("reason") or "auto")
            by_reason[r] = by_reason.get(r, 0) + 1
        summary = ", ".join(f"{n} {REASON_LABEL.get(r, r)}" for r, n in by_reason.items())
        lines.append(f"- {len(all_comps)} total: {summary}.")
        last_c = all_comps[-1]
        if last_c.get("before") and last_c.get("after"):
            lines.append(
                f"- Latest: {fmt_k(int(last_c['before']))} -> {fmt_k(int(last_c['after']))} "
                f"(saved ~{fmt_k(max(0, int(last_c['before']) - int(last_c['after'])))}/step)."
            )

    return "\n".join(lines)


def sys_step(message: str) -> dict[str, Any]:
    """Build an injectSteps systemMessage without metadata (avoids agy ScrubInternalFields map panic)."""
    return {"systemMessage": {"systemMessage": message}}


def project_name(workspace_paths: list[str] | None) -> str:
    for wp in workspace_paths or []:
        parts = [p for p in re.split(r"[\\/]", wp) if p]
        if parts:
            return parts[-1]
    return "workspace"


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    cli_event = sys.argv[1] if len(sys.argv) > 1 else ""
    if cli_event in ("PostToolUse", "PostInvocation", "Stop"):
        sys.stdout.write("{}\n")
        return

    raw = sys.stdin.read()
    payload: dict[str, Any] = {}
    if raw.strip():
        try:
            payload = json.loads(raw)
        except Exception:
            pass

    event_type = cli_event or str(payload.get("hookEventName") or "PreInvocation")
    if event_type in ("PostToolUse", "PostInvocation", "Stop"):
        sys.stdout.write("{}\n")
        return

    now_ms = int(time.time() * 1000)
    conv_id = str(payload.get("conversationId") or "default")
    ws_paths = payload.get("workspacePaths") if isinstance(payload.get("workspacePaths"), list) else []

    state = load_state(now_ms)
    base = state.get("baseSnapshot")
    if (
        not isinstance(base, dict)
        or int(base.get("version") or 0) < SNAPSHOT_VERSION
        or (now_ms - int(base.get("at") or 0)) > DAY_MS
    ):
        base = estimate_base_overhead(ws_paths)
        state["baseSnapshot"] = base

    sess = state["sessions"].get(conv_id)
    if not isinstance(sess, dict):
        sess = {
            "id": conv_id,
            "project": project_name(ws_paths),
            "startedAt": now_ms,
            "updatedAt": now_ms,
            "steps": 0,
            "facts": empty_facts(),
            "epochFiles": [],
            "recentFingerprints": [],
            "compactionLog": [],
            "floor": 0,
            "lastScannedOffset": 0,
            "lastCtx": 0,
            "peakCtx": 0,
            "lastCompactNudgeCtx": 0,
        }
        state["sessions"][conv_id] = sess
    elif ws_paths and not sess.get("project"):
        sess["project"] = project_name(ws_paths)

    sync_from_transcript(sess, state, payload.get("transcriptPath"), now_ms)

    if event_type == "SessionStart":
        save_state(state)
        sys.stdout.write("{}\n")
        return

    if event_type == "PreInvocation":
        # Antigravity invocationNum is 0-indexed (0 or omitted on first call of a turn, >0 after tool calls).
        raw_inv = payload.get("invocationNum")
        inv_num = int(raw_inv) if raw_inv is not None else 0
        if inv_num > 0:
            save_state(state)
            sys.stdout.write("{}\n")
            return

        trigger_type = str(sess.get("lastTriggerType") or "USER_INPUT")
        user_input = str(payload.get("lastUserInput") or "").strip()
        model_name = str(payload.get("modelName") or "")
        ctx = int(sess.get("lastCtx") or 0)
        floor = int(sess.get("floor") or 0)
        inject_steps: list[dict[str, Any]] = []

        # Post-compaction resume turn: never re-nudge or re-classify stale user input.
        if trigger_type == "CHECKPOINT":
            save_state(state)
            sys.stdout.write("{}\n")
            return

        # Reactive wakeup (background task or subagent completion): payload still carries previous lastUserInput.
        if trigger_type == "SYSTEM_MESSAGE":
            last_nudge = int(sess.get("lastCompactNudgeCtx") or 0)
            if ctx >= HARD_LIMIT and (ctx - floor) >= MIN_GROWTH and (last_nudge == 0 or (ctx - last_nudge) >= MIN_GROWTH):
                facts = sess.get("facts") or empty_facts()
                instructions = build_compact_instructions(
                    "hard-limit",
                    sess.get("epochFiles") or [],
                    bool(facts.get("committed")),
                    bool(facts.get("testsPassed")),
                    bool(facts.get("editedAfterTests")),
                )
                sess["lastCompactNudgeCtx"] = ctx
                sess["lastCompactReason"] = "hard-limit"
                ev_line = f"a good moment to compact ({math.floor(ctx / 1000)}k){SEP}{REASON_LABEL['hard-limit']}{SEP}run /compact"
                bar_md = render_markdown_bar(ctx, HARD_LIMIT, sess, ev_line)
                inject_steps.append(
                    sys_step(
                        f"longhaul smart compaction checkpoint ({REASON_LABEL['hard-limit']}):\n"
                        f"{bar_md}\n\n{instructions}\n\n"
                        "Include the meter line above at the end of your reply and recommend `/compact`."
                    )
                )
            save_state(state)
            sys.stdout.write((json.dumps({"injectSteps": inject_steps}) if inject_steps else "{}") + "\n")
            return

        # Explicit diagnostic commands (`longhaul`, `/longhaul`, `longhaul health`, `/longhaul health`).
        if CMD_HEALTH_RE.match(user_input):
            report = render_health_report(base, state["mcpCalls"], state)
            inject_steps.append(
                sys_step(
                    "The user asked for the longhaul context health report. "
                    "Present this exact report cleanly without extra filler:\n\n" + report
                )
            )
            save_state(state)
            sys.stdout.write(json.dumps({"injectSteps": inject_steps}) + "\n")
            return

        if CMD_STATUS_RE.match(user_input):
            report = render_status_report(sess, state, base)
            inject_steps.append(
                sys_step(
                    "The user asked for the longhaul status report. "
                    "Present this exact report cleanly without extra filler:\n\n" + report
                )
            )
            save_state(state)
            sys.stdout.write(json.dumps({"injectSteps": inject_steps}) + "\n")
            return

        facts = sess.get("facts") or empty_facts()
        task_done = is_task_done(facts)
        recent_fps = list(sess.get("recentFingerprints") or [])
        new_task = is_new_task(user_input, recent_fps) if user_input else False

        enough_growth = ctx > 0 and (ctx - floor) >= MIN_GROWTH
        over_soft = ctx >= SOFT_LIMIT and enough_growth
        over_hard = ctx >= HARD_LIMIT and enough_growth
        last_nudge = int(sess.get("lastCompactNudgeCtx") or 0)
        can_nudge = last_nudge == 0 or (ctx - last_nudge) >= MIN_GROWTH

        should_compact = can_nudge and (over_hard or (over_soft and (task_done or new_task)))
        if should_compact:
            reason = "hard-limit" if over_hard else ("task-done" if task_done else "new-task")
            instructions = build_compact_instructions(
                reason,
                sess.get("epochFiles") or [],
                bool(facts.get("committed")),
                bool(facts.get("testsPassed")),
                bool(facts.get("editedAfterTests")),
            )
            sess["lastCompactNudgeCtx"] = ctx
            sess["lastCompactReason"] = reason
            ev_line = f"a good moment to compact ({math.floor(ctx / 1000)}k){SEP}{REASON_LABEL[reason]}{SEP}run /compact"
            bar_md = render_markdown_bar(ctx, HARD_LIMIT, sess, ev_line)
            inject_steps.append(
                sys_step(
                    f"longhaul smart compaction checkpoint ({REASON_LABEL[reason]}):\n"
                    f"{bar_md}\n\n{instructions}\n\n"
                    "Include the meter line above at the end of your reply and recommend `/compact` once you finish answering."
                )
            )
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
            recent_fps.append(prompt_fingerprint(user_input))
            sess["recentFingerprints"] = recent_fps[-3:]
            sess["facts"] = empty_facts()

            if not is_light_model(model_name) and classify_prompt(user_input) == "sonnet":
                inject_steps.append(sys_step(AGY_HANDOFF))

        save_state(state)
        sys.stdout.write((json.dumps({"injectSteps": inject_steps}) if inject_steps else "{}") + "\n")
        return

    save_state(state)
    sys.stdout.write("{}\n")


if __name__ == "__main__":
    main()
