import sys
import json
import unittest
from pathlib import Path

# Add vm-app to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vm-app"))
from app import gemini_compat

class TestGeminiCompat(unittest.TestCase):
    def test_apply_thinking_gemini_3_flash(self):
        rr = {
            "strategy": "gemini_thinking_matrix",
            "model_matrix": {"flash": ["minimal", "low", "medium", "high"]},
            "thought_tag_marker": True,
            "headroom_elevation": True
        }
        # 1. high effort
        out = {"reasoning_effort": "high", "max_tokens": 4096}
        gemini_compat.apply_thinking(out, rr, "gemini-3.5-flash")
        self.assertNotIn("reasoning_effort", out)
        google = out["extra_body"]["google"]
        self.assertEqual(google["thinking_config"]["thinking_level"], "high")
        self.assertTrue(google["thinking_config"]["include_thoughts"])
        self.assertEqual(google["thought_tag_marker"], "thought")
        self.assertEqual(out["max_tokens"], 65535)

        # 2. none effort -> minimal
        out = {"reasoning_effort": "none"}
        gemini_compat.apply_thinking(out, rr, "gemini-3.5-flash")
        google = out["extra_body"]["google"]
        self.assertEqual(google["thinking_config"]["thinking_level"], "minimal")
        self.assertFalse(google["thinking_config"]["include_thoughts"])

    def test_apply_thinking_gemini_25_flash(self):
        rr = {"strategy": "gemini_thinking_matrix"}
        # none effort on 2.5 Flash -> thinking_budget 0
        out = {"reasoning_effort": "none"}
        gemini_compat.apply_thinking(out, rr, "gemini-2.5-flash")
        google = out["extra_body"]["google"]
        self.assertEqual(google["thinking_config"]["thinking_budget"], 0)
        self.assertFalse(google["thinking_config"]["include_thoughts"])

        # high effort on 2.5 Flash -> 24576
        out = {"reasoning_effort": "high"}
        gemini_compat.apply_thinking(out, rr, "gemini-2.5-flash")
        google = out["extra_body"]["google"]
        self.assertEqual(google["thinking_config"]["thinking_budget"], 24576)
        self.assertTrue(google["thinking_config"]["include_thoughts"])

    def test_thought_signatures_roundtrip(self):
        # 1. Sign tool call from upstream response
        response_data = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_abc123",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": "{}"},
                        "extra_content": {
                            "google": {"thought_signature": "SIG_XYZ_789"}
                        }
                    }]
                }
            }]
        }
        normalized = gemini_compat.normalize_response(response_data)
        tc = normalized["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual(tc["id"], "call_abc123:::SIG_XYZ_789")

        # 2. Next turn: client echoes the signed tool_call_id
        next_request = {
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_abc123:::SIG_XYZ_789",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": "{}"}
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_abc123:::SIG_XYZ_789",
                    "content": "25 C"
                }
            ]
        }
        # To Gemini (keep=True)
        gemini_compat.restore_signatures(next_request, keep=True)
        m_asst = next_request["messages"][0]
        m_tool = next_request["messages"][1]
        self.assertEqual(m_asst["tool_calls"][0]["id"], "call_abc123")
        self.assertEqual(m_asst["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "SIG_XYZ_789")
        self.assertEqual(m_tool["tool_call_id"], "call_abc123")

        # 3. Failover to Non-Gemini (keep=False)
        next_request2 = {
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_abc123:::SIG_XYZ_789",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": "{}"}
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_abc123:::SIG_XYZ_789",
                    "content": "25 C"
                }
            ]
        }
        gemini_compat.restore_signatures(next_request2, keep=False)
        self.assertEqual(next_request2["messages"][0]["tool_calls"][0]["id"], "call_abc123")
        self.assertNotIn("extra_content", next_request2["messages"][0]["tool_calls"][0])
        self.assertEqual(next_request2["messages"][1]["tool_call_id"], "call_abc123")

    def test_split_thoughts_non_streaming(self):
        text = "<thought>Thinking very hard here...</thought>Hello! Here is the answer."
        r, a = gemini_compat._split_thoughts(text)
        self.assertEqual(r, "Thinking very hard here...")
        self.assertEqual(a, "Hello! Here is the answer.")

    def test_streaming_thought_splitter(self):
        splitter = gemini_compat._ThoughtSplitter()
        chunks = ["<tho", "ught>I am thin", "king</tho", "ught>The final answer!"]
        results = [splitter.feed(c) for c in chunks]
        reasonings = [r for r, a in results if r]
        answers = [a for r, a in results if a]
        full_r = "".join(reasonings)
        full_a = "".join(answers)
        self.assertEqual(full_r, "I am thinking")
        self.assertEqual(full_a, "The final answer!")

if __name__ == "__main__":
    unittest.main()
