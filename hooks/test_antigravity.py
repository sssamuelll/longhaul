import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HOOK_SCRIPT = Path(__file__).resolve().parent / "antigravity.py"


def assert_no_panic_fields(test: unittest.TestCase, parsed: dict) -> None:
    """Ensure hook output never emits systemMessage.metadata (causes agy Go panic) or deprecated ephemeralMessage."""
    for step in parsed.get("injectSteps") or []:
        test.assertNotIn("ephemeralMessage", step)
        if "systemMessage" in step:
            sm = step["systemMessage"]
            test.assertIsInstance(sm, dict)
            test.assertNotIn("metadata", sm, "systemMessage.metadata triggers ScrubInternalFields panic in agy")
            test.assertIsInstance(sm.get("systemMessage"), str)


class AntigravityHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state_file = self.root / "state.json"
        self.transcript = self.root / "transcript.jsonl"
        self.art_dir = self.root / "artifacts"
        self.app_data = self.root / "agy-app"
        (self.app_data / "mcp" / "demo_srv").mkdir(parents=True)
        (self.app_data / "mcp" / "demo_srv" / "tool_a.json").write_text('{"name":"tool_a","description":"demo"}', encoding="utf-8")
        (self.app_data / "builtin" / "skills" / "demo_skill").mkdir(parents=True)
        (self.app_data / "builtin" / "skills" / "demo_skill" / "SKILL.md").write_text("---\nname: demo\n---\n", encoding="utf-8")
        self.ws = self.root / "proj"
        self.ws.mkdir()
        (self.ws / "AGENTS.md").write_text("Rule line one\nRule line two\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def append_steps(self, *steps: dict) -> None:
        with self.transcript.open("a", encoding="utf-8") as f:
            for s in steps:
                f.write(json.dumps(s) + "\n")

    def run_hook(self, event: str, payload: dict, extra_env: dict | None = None) -> dict:
        env = os.environ.copy()
        env["LONGHAUL_AGY_STATE"] = str(self.state_file)
        env["AGY_APP_DATA_DIR"] = str(self.app_data)
        if extra_env:
            env.update(extra_env)
        base_payload = {
            "conversationId": "conv-1",
            "transcriptPath": str(self.transcript),
            "workspacePaths": [str(self.ws)],
            "artifactDirectoryPath": str(self.art_dir),
            "modelName": "gemini-3.1-pro",
        }
        base_payload.update(payload)
        proc = subprocess.run(
            [sys.executable, str(HOOK_SCRIPT), event],
            input=json.dumps(base_payload),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertEqual(proc.stderr, "")
        out = json.loads(proc.stdout)
        assert_no_panic_fields(self, out)
        return out

    def read_state(self) -> dict:
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def test_session_start_and_quiet_turn_emit_empty_json_without_false_compaction(self) -> None:
        out_start = self.run_hook("SessionStart", {})
        self.assertEqual(out_start, {})

        self.append_steps({"step_index": 0, "type": "USER_INPUT", "content": "investigate why auth fails"})
        out_pre0 = self.run_hook("PreInvocation", {"lastUserInput": "investigate why auth fails"})
        self.assertEqual(out_pre0, {})

        # First model response arrives at 24k tokens (lower than older 242k estimates): must NOT count as compaction.
        self.append_steps({
            "step_index": 1,
            "type": "PLANNER_RESPONSE",
            "input_tokens": 24_267,
            "cache_read_tokens": 0,
            "output_tokens": 350,
            "tool_calls": [{"name": "edit_file", "args": {"Path": "/repo/auth.py"}}],
        }, {
            "step_index": 2,
            "type": "GENERIC",
            "status": "DONE",
            "content": "Edited file",
        })

        # Second model call in same turn has invocationNum=1: must sync facts and NOT wipe them!
        out_pre1 = self.run_hook("PreInvocation", {"invocationNum": 1, "lastUserInput": "investigate why auth fails"})
        self.assertEqual(out_pre1, {})

        st = self.read_state()
        sess = st["sessions"]["conv-1"]
        self.assertEqual(sess["floor"], 24_267)
        self.assertEqual(sess["lastCtx"], 24_267)
        self.assertEqual(sess["compactionLog"], [])
        self.assertEqual(sess["facts"]["editedFiles"], ["/repo/auth.py"])
        self.assertEqual(len(sess["recentFingerprints"]), 1)

        # Privacy check: raw prompt text must never appear in state.json
        raw_state = self.state_file.read_text(encoding="utf-8")
        self.assertNotIn("investigate why auth fails", raw_state)

    def test_async_background_test_and_system_message_wakeup(self) -> None:
        self.append_steps({"step_index": 0, "type": "USER_INPUT", "content": "why is parser broken"})
        self.run_hook("PreInvocation", {"lastUserInput": "why is parser broken"})

        # Edit file + start async pytest background command
        self.append_steps(
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "input_tokens": 30_000,
                "cache_read_tokens": 0,
                "tool_calls": [
                    {"name": "edit_file", "args": {"Path": "/repo/parser.py"}},
                    {"name": "run_command", "args": {"CommandLine": "python3 -m unittest discover -v"}},
                ],
            },
            {"step_index": 2, "type": "GENERIC", "status": "DONE", "content": "Edited"},
            {
                "step_index": 3,
                "type": "GENERIC",
                "status": "RUNNING",
                "content": "Tool is running as a background task with task id: conv-1/task-3",
            },
        )
        self.run_hook("PreInvocation", {"invocationNum": 1, "lastUserInput": "why is parser broken"})
        sess_mid = self.read_state()["sessions"]["conv-1"]
        self.assertFalse(sess_mid["facts"]["testsPassed"], "RUNNING task must not mark testsPassed early")
        self.assertNotIn("unittest", self.state_file.read_text(encoding="utf-8"), "raw command must not be stored")

        # Background task finishes via SYSTEM_MESSAGE reactive wakeup (invocationNum resets to 0!)
        self.append_steps({
            "step_index": 4,
            "type": "SYSTEM_MESSAGE",
            "status": "DONE",
            "content": 'Task id "conv-1/task-3" finished with result:\nCommand exited with code 0.',
        })
        out_wakeup = self.run_hook("PreInvocation", {"invocationNum": 0, "lastUserInput": "run the tests"})
        self.assertEqual(out_wakeup, {}, "SYSTEM_MESSAGE wakeup must not re-classify stale lastUserInput")

        sess_done = self.read_state()["sessions"]["conv-1"]
        self.assertTrue(sess_done["facts"]["testsPassed"])
        self.assertEqual(sess_done["facts"]["editedFiles"], ["/repo/parser.py"])
        self.assertEqual(len(sess_done["recentFingerprints"]), 1)

    def test_smart_compaction_epoch_persistence_throttling_and_checkpoint_reset(self) -> None:
        # Turn 1 at 30k: edit file_1.py and pass tests (below soft limit)
        self.append_steps({"step_index": 0, "type": "USER_INPUT", "content": "design step one"})
        self.run_hook("PreInvocation", {"lastUserInput": "design step one"})
        self.append_steps(
            {
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "input_tokens": 30_000,
                "cache_read_tokens": 0,
                "tool_calls": [
                    {"name": "edit_file", "args": {"Path": "/repo/file_1.py"}},
                    {"name": "run_command", "args": {"CommandLine": "pytest"}},
                ],
            },
            {"step_index": 2, "type": "GENERIC", "status": "DONE", "content": "ok"},
            {"step_index": 3, "type": "GENERIC", "status": "DONE", "content": "Command exited with code 0."},
            {"step_index": 4, "type": "USER_INPUT", "content": "design step two"},
        )
        # Turn 2 at 30k (under soft limit): epochFiles must keep file_1.py!
        out_t2 = self.run_hook("PreInvocation", {"lastUserInput": "design step two"})
        self.assertEqual(out_t2, {})
        self.assertEqual(self.read_state()["sessions"]["conv-1"]["epochFiles"], ["/repo/file_1.py"])

        # Turn 2 grows to 175k (>150k soft limit and >30k+50k floor), edits file_2.py, passes tests
        self.append_steps(
            {
                "step_index": 5,
                "type": "PLANNER_RESPONSE",
                "input_tokens": 15_000,
                "cache_read_tokens": 160_000,
                "tool_calls": [
                    {"name": "edit_file", "args": {"Path": "/repo/file_2.py"}},
                    {"name": "run_command", "args": {"CommandLine": "pytest"}},
                ],
            },
            {"step_index": 6, "type": "GENERIC", "status": "DONE", "content": "ok"},
            {"step_index": 7, "type": "GENERIC", "status": "DONE", "content": "Command exited with code 0."},
            {"step_index": 8, "type": "USER_INPUT", "content": "what should we check next?"},
        )
        out_t3 = self.run_hook("PreInvocation", {"lastUserInput": "what should we check next?"})
        self.assertEqual(len(out_t3.get("injectSteps", [])), 1)
        msg = out_t3["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("smart compaction checkpoint (task finished)", msg)
        self.assertIn("/repo/file_1.py", msg)
        self.assertIn("/repo/file_2.py", msg)
        self.assertTrue((self.art_dir / "longhaul-compaction-brief.md").is_file())

        # Immediate next turn at 185k (< +50k from last nudge) with new task must be throttled
        self.append_steps(
            {"step_index": 9, "type": "PLANNER_RESPONSE", "input_tokens": 5_000, "cache_read_tokens": 180_000},
            {"step_index": 10, "type": "USER_INPUT", "content": "now let's switch topics completely"},
        )
        out_throttled = self.run_hook("PreInvocation", {"lastUserInput": "now let's switch topics completely"})
        self.assertEqual(out_throttled, {})

        # Real Antigravity CHECKPOINT occurs at 190k -> resumes at 28k
        self.append_steps({
            "step_index": 11,
            "type": "CHECKPOINT",
            "input_tokens": 4_000,
            "cache_read_tokens": 186_000,
            "content": "# Resuming from a compaction",
        })
        out_chk = self.run_hook("PreInvocation", {"invocationNum": 0, "lastUserInput": "now let's switch topics completely"})
        self.assertEqual(out_chk, {})

        self.append_steps(
            {"step_index": 12, "type": "PLANNER_RESPONSE", "input_tokens": 6_000, "cache_read_tokens": 22_000},
            {"step_index": 13, "type": "USER_INPUT", "content": "status check"},
        )
        self.run_hook("PreInvocation", {"lastUserInput": "status check"})
        sess_after = self.read_state()["sessions"]["conv-1"]
        self.assertEqual(sess_after["floor"], 28_000)
        self.assertEqual(sess_after["epochFiles"], [])
        self.assertEqual(len(sess_after["compactionLog"]), 1)
        self.assertEqual(sess_after["compactionLog"][0]["before"], 190_000)
        self.assertEqual(sess_after["compactionLog"][0]["after"], 28_000)
        self.assertEqual(sess_after["compactionLog"][0]["reason"], "task-done")

    def test_status_vs_health_commands_and_spanish_classifier_and_light_model_skip(self) -> None:
        self.append_steps(
            {"step_index": 0, "type": "USER_INPUT", "content": "longhaul"},
        )
        out_status = self.run_hook("PreInvocation", {"lastUserInput": "longhaul"})
        status_txt = out_status["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("longhaul report (Antigravity)", status_txt)
        self.assertIn("▎ context", status_txt)

        self.append_steps({"step_index": 1, "type": "USER_INPUT", "content": "/longhaul health"})
        out_health = self.run_hook("PreInvocation", {"lastUserInput": "/longhaul health"})
        health_txt = out_health["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("Context health (Antigravity)", health_txt)
        self.assertIn("demo_srv MCP", health_txt)

        # Spanish execution prompt -> AGY_HANDOFF on heavy model
        self.append_steps({"step_index": 2, "type": "USER_INPUT", "content": "corre las pruebas por favor"})
        out_es = self.run_hook("PreInvocation", {"lastUserInput": "corre las pruebas por favor", "modelName": "claude-opus-4-6"})
        self.assertEqual(len(out_es["injectSteps"]), 1)
        self.assertIn("invoke_subagent", out_es["injectSteps"][0]["systemMessage"]["systemMessage"])

        # Same prompt on flash model -> NO handoff
        self.append_steps({"step_index": 3, "type": "USER_INPUT", "content": "corre las pruebas por favor"})
        out_flash = self.run_hook("PreInvocation", {"lastUserInput": "corre las pruebas por favor", "modelName": "gemini-3-flash"})
        self.assertEqual(out_flash, {})

        # Spanish architecture/why prompt -> Opus (NO handoff)
        self.append_steps({"step_index": 4, "type": "USER_INPUT", "content": "por qué falla la arquitectura de pagos y corre las pruebas"})
        out_opus = self.run_hook("PreInvocation", {"lastUserInput": "por qué falla la arquitectura de pagos y corre las pruebas", "modelName": "claude-opus-4-6"})
        self.assertEqual(out_opus, {})

    def test_legacy_state_healing_and_retention_pruning(self) -> None:
        now_ms = int(time.time() * 1000)
        old_ms = now_ms - (25 * 86_400_000)
        legacy = {
            "startedAt": now_ms,
            "mcpCalls": {},
            "baseSnapshot": {"at": now_ms, "total": 242_699, "mcp": {}, "memory": [], "skills": {"count": 0, "tokens": 0}},
            "sessions": {
                "expired": {"id": "expired", "startedAt": old_ms, "lastCtx": 50_000, "peakCtx": 50_000},
                "poisoned": {
                    "id": "poisoned",
                    "startedAt": now_ms - 1000,
                    "recentPrompts": ["secret user prompt text with several words inside"],
                    "floor": 242_699,
                    "lastCtx": 85_000,
                    "peakCtx": 243_360,
                },
            },
        }
        self.state_file.write_text(json.dumps(legacy), encoding="utf-8")
        self.run_hook("SessionStart", {"conversationId": "poisoned"})

        healed = self.read_state()
        self.assertNotIn("expired", healed["sessions"])
        p_sess = healed["sessions"]["poisoned"]
        self.assertNotIn("recentPrompts", p_sess)
        self.assertEqual(len(p_sess["recentFingerprints"]), 1)
        self.assertEqual(p_sess["peakCtx"], 85_000)
        self.assertEqual(p_sess["floor"], 30_000)
        self.assertEqual(healed["baseSnapshot"]["version"], 2)
        self.assertLess(healed["baseSnapshot"]["total"], 50_000)
        self.assertNotIn("secret user prompt text", self.state_file.read_text(encoding="utf-8"))

    def test_candidate_roots_handles_wsl_windows_user_path_without_looping(self) -> None:
        import antigravity
        roots = antigravity.candidate_roots(["/mnt/c/Users/nonexistent_test_user/work/repo"])
        self.assertIsInstance(roots, list)


if __name__ == "__main__":
    unittest.main()
