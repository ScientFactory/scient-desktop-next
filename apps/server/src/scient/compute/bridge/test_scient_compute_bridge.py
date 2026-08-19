#!/usr/bin/env python3
"""Unit tests for the Scient compute bridge.

These tests use only the standard library and fake the kernel manager and
channels.  They must not require ZeroMQ or a real kernel.
"""

import io
import json
import struct
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Add the bridge directory to the path so we can import the module.
import os
sys.path.insert(0, os.path.dirname(__file__))

import scient_compute_bridge as bridge


class TestFraming(unittest.TestCase):
    """Tests for frame encoding and decoding."""

    def test_encode_frame_produces_length_prefix_and_payload(self):
        msg = {"type": "hello", "payload": {"token": "abc"}}
        frame = bridge.encode_frame(msg)
        (length,) = struct.unpack(">I", frame[:4])
        self.assertEqual(length, len(frame) - 4)
        self.assertEqual(json.loads(frame[4:].decode("utf-8")), msg)

    def test_read_frame_round_trips(self):
        msg = {"type": "execute", "payload": {"code": "print(1)"}}
        frame = bridge.encode_frame(msg)
        stream = io.BytesIO(frame)
        result = bridge.read_frame(stream)
        self.assertEqual(result, msg)

    def test_read_frame_returns_none_on_clean_eof(self):
        stream = io.BytesIO(b"")
        with self.assertRaises(EOFError):
            bridge.read_frame(stream)

    def test_encode_frame_rejects_oversized_payload(self):
        msg = {"type": "stream", "payload": {"text": "x" * (bridge.MAX_FRAME + 1)}}
        with self.assertRaises(ValueError):
            bridge.encode_frame(msg)


class TestBoundedOutboundQueue(unittest.TestCase):
    """Tests for the bounded outbound queue."""

    def test_accepts_frames_within_count_limit(self):
        q = bridge.BoundedOutboundQueue(max_frames=3, max_bytes=1024)
        q.put(b"one")
        q.put(b"two")
        q.put(b"three")
        self.assertEqual(len(q.drain()), 3)

    def test_rejects_frame_exceeding_count_limit(self):
        q = bridge.BoundedOutboundQueue(max_frames=2, max_bytes=1024)
        q.put(b"one")
        q.put(b"two")
        with self.assertRaises(RuntimeError, msg="frames"):
            q.put(b"three")

    def test_rejects_frame_exceeding_byte_limit(self):
        q = bridge.BoundedOutboundQueue(max_frames=10, max_bytes=10)
        q.put(b"fivebytes")
        with self.assertRaises(RuntimeError, msg="bytes"):
            q.put(b"sixbytes")

    def test_drain_resets_counts(self):
        q = bridge.BoundedOutboundQueue(max_frames=2, max_bytes=1024)
        q.put(b"one")
        q.drain()
        q.put(b"two")
        q.put(b"three")
        self.assertEqual(len(q.drain()), 2)

    def test_rejects_after_close(self):
        q = bridge.BoundedOutboundQueue()
        q.close()
        with self.assertRaises(RuntimeError):
            q.put(b"data")


class TestExecuteMapping(unittest.TestCase):
    """Tests for execute correlation state."""

    def test_is_complete_requires_reply_busy_and_idle(self):
        m = bridge.ExecuteMapping()
        self.assertFalse(m.is_complete())
        m.shell_reply = {"status": "ok"}
        m.iopub_busy = True
        self.assertFalse(m.is_complete())
        m.iopub_idle = True
        self.assertTrue(m.is_complete())

    def test_outcome_succeeded(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        m.iopub_busy = True
        m.iopub_idle = True
        self.assertEqual(m.outcome(), "succeeded")

    def test_outcome_failed_on_error_reply(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error"}
        m.iopub_busy = True
        m.iopub_idle = True
        self.assertEqual(m.outcome(), "failed")

    def test_outcome_failed_on_error_observed(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        m.error_observed = True
        m.iopub_busy = True
        m.iopub_idle = True
        self.assertEqual(m.outcome(), "failed")

    def test_outcome_cancelled_after_interrupt(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        m.interrupt_requested = True
        m.iopub_busy = True
        m.iopub_idle = True
        self.assertEqual(m.outcome(), "cancelled")

    def test_reset_clears_all_state(self):
        m = bridge.ExecuteMapping()
        m.active_request_id = "req-1"
        m.active_msg_id = "msg-1"
        m.shell_reply = {"status": "ok"}
        m.iopub_busy = True
        m.iopub_idle = True
        m.error_observed = True
        m.interrupt_requested = True
        m.reset()
        self.assertIsNone(m.active_request_id)
        self.assertIsNone(m.active_msg_id)
        self.assertIsNone(m.shell_reply)
        self.assertFalse(m.iopub_busy)
        self.assertFalse(m.iopub_idle)
        self.assertFalse(m.error_observed)
        self.assertFalse(m.interrupt_requested)


class TestBridgeHandshake(unittest.TestCase):
    """Tests for the bridge handshake protocol."""

    def test_hello_sets_session_and_sends_hello_ack(self):
        stdout = MagicMock()
        stdout.buffer = io.BytesIO()
        b = bridge.ScientBridge(sys.stdin, stdout)
        b._handle_hello({
            "sessionId": "test-session",
            "ownerToken": "token-123",
            "requiredCapabilities": ["execute", "interrupt", "restart", "shutdown"],
        })
        frames = b._outbound.drain()
        self.assertEqual(len(frames), 1)
        msg = json.loads(frames[0][4:].decode("utf-8"))
        self.assertEqual(msg["type"], "hello-ack")
        self.assertEqual(msg["payload"]["ownerToken"], "token-123")
        self.assertEqual(msg["payload"]["pid"], os.getpid())
        self.assertIn("execute", msg["payload"]["capabilities"])

    def test_hello_rejects_missing_capabilities(self):
        stdout = MagicMock()
        stdout.buffer = io.BytesIO()
        b = bridge.ScientBridge(sys.stdin, stdout)
        b._handle_hello({
            "sessionId": "test-session",
            "ownerToken": "token-123",
            "requiredCapabilities": ["execute", "interrupt", "restart", "shutdown", "variables"],
        })
        # _handle_hello calls _flush which drains the queue into stdout.buffer.
        data = stdout.buffer.getvalue()
        (length,) = struct.unpack(">I", data[:4])
        msg = json.loads(data[4:4 + length].decode("utf-8"))
        self.assertEqual(msg["type"], "fatal")
        self.assertIn("variables", msg["payload"]["reason"])
        self.assertFalse(b._running)


class TestBridgeIOPubMapping(unittest.TestCase):
    """Tests for IOPub message to protocol event mapping."""

    def setUp(self):
        self.stdout = MagicMock()
        self.stdout.buffer = io.BytesIO()
        self.b = bridge.ScientBridge(sys.stdin, self.stdout)

    def _drain_messages(self):
        return [json.loads(f[4:].decode("utf-8")) for f in self.b._outbound.drain()]

    def test_stream_maps_to_stream_event(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("stream",
                                          {"name": "stdout", "text": "hello\n"},
                                          "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "stream")
        self.assertEqual(msgs[0]["payload"]["stream"], "stdout")
        self.assertEqual(msgs[0]["payload"]["text"], "hello\n")
        self.assertEqual(msgs[0]["requestId"], "req-1")

    def test_display_png_maps_to_display_event(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("display_data",
                                          {"data": {"image/png": "iVBORw0KGgo="}},
                                          "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["mediaType"], "image/png")
        self.assertEqual(msgs[0]["payload"]["data"], "iVBORw0KGgo=")

    def test_display_text_fallback(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("execute_result",
                                          {"data": {"text/plain": "42"}},
                                          "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["mediaType"], "text/plain")
        self.assertEqual(msgs[0]["payload"]["text"], "42")

    def test_error_maps_to_error_event(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("error",
                                          {"ename": "ValueError",
                                           "evalue": "bad",
                                           "traceback": ["line 1", "line 2"]},
                                          "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "error")
        self.assertEqual(msgs[0]["payload"]["name"], "ValueError")
        self.assertEqual(msgs[0]["payload"]["value"], "bad")
        self.assertTrue(self.b._mapping.error_observed)

    def test_status_busy_sets_mapping(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("status",
                                          {"execution_state": "busy"},
                                          "req-1"))
        self.assertTrue(self.b._mapping.iopub_busy)

    def test_status_idle_sets_mapping(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("status",
                                          {"execution_state": "idle"},
                                          "req-1"))
        self.assertTrue(self.b._mapping.iopub_idle)

    def test_update_display_emits_warning(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("update_display_data", {}, "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "runtime-warning")

    def test_clear_output_emits_warning(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("clear_output", {}, "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "runtime-warning")

    def test_input_request_emits_warning(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("input_request", {}, "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "input-unsupported")

    def test_oversized_stream_truncates_with_warning(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("stream",
                                          {"name": "stdout",
                                           "text": "x" * (bridge.MAX_STREAM_TEXT + 100)},
                                          "req-1"))
        msgs = self._drain_messages()
        # First message is the truncated stream, second is the warning.
        self.assertEqual(msgs[0]["type"], "stream")
        self.assertLessEqual(len(msgs[0]["payload"]["text"].encode("utf-8")),
                             bridge.MAX_STREAM_TEXT)
        self.assertEqual(msgs[1]["type"], "warning")
        self.assertEqual(msgs[1]["payload"]["code"], "output-truncated")

    def test_unknown_mime_is_ignored(self):
        import asyncio
        asyncio.run(self.b._handle_iopub("display_data",
                                          {"data": {"text/html": "<b>bold</b>"}},
                                          "req-1"))
        msgs = self._drain_messages()
        self.assertEqual(len(msgs), 0)


class TestBridgeInterrupt(unittest.TestCase):
    """Tests for interrupt handling."""

    def test_interrupt_no_active_returns_terminal(self):
        import asyncio
        stdout = MagicMock()
        stdout.buffer = io.BytesIO()
        b = bridge.ScientBridge(sys.stdin, stdout)
        asyncio.run(b._handle_interrupt("req-1"))
        msgs = [json.loads(f[4:].decode("utf-8"))
                for f in b._outbound.drain()]
        self.assertEqual(msgs[0]["type"], "interrupt-result")
        self.assertEqual(msgs[0]["payload"]["result"], "terminal")

    def test_interrupt_wrong_request_returns_rejected(self):
        import asyncio
        stdout = MagicMock()
        stdout.buffer = io.BytesIO()
        b = bridge.ScientBridge(sys.stdin, stdout)
        b._mapping.active_request_id = "req-active"
        asyncio.run(b._handle_interrupt("req-other"))
        msgs = [json.loads(f[4:].decode("utf-8"))
                for f in b._outbound.drain()]
        self.assertEqual(msgs[0]["payload"]["result"], "rejected")


if __name__ == "__main__":
    unittest.main()
