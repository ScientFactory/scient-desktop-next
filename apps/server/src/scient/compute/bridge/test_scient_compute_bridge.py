#!/usr/bin/env python3
"""Unit tests for the Scient compute bridge.

These tests use only the standard library and fake the kernel manager and
channels.  They must not require ZeroMQ or a real kernel, so they exercise the
bridge's own logic -- framing, correlation, outcome, interrupt and the fd-1
protection -- rather than Jupyter's.
"""

import asyncio
import io
import json
import os
import queue
import signal
import struct
import subprocess
import sys
import tempfile
import unittest

# Add the bridge directory to the path so we can import the module.
sys.path.insert(0, os.path.dirname(__file__))

import scient_compute_bridge as bridge


def make_bridge(initialized=True):
    output = io.BytesIO()
    instance = bridge.ScientBridge(io.BytesIO(), output)
    if initialized:
        instance._session_id = "test-session"
        instance._handshake_complete = True
    return instance, output


def decode_frames(data):
    """Split a written byte stream back into protocol messages."""
    messages = []
    offset = 0
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        offset += 4
        messages.append(json.loads(data[offset : offset + length].decode("utf-8")))
        offset += length
    return messages


def queued(instance):
    return [json.loads(f[4:].decode("utf-8")) for f in instance._outbound.drain()]


class FakeKernelClient:
    """A kernel client that replays scripted channel messages."""

    def __init__(self, iopub=None, shell=None):
        self.iopub = list(iopub or [])
        self.shell = list(shell or [])
        self.executed = []
        self.execute_requests = []
        self.execute_error = None
        self.channels_stopped = False

    def execute(
        self,
        code,
        silent=False,
        store_history=True,
        user_expressions=None,
        allow_stdin=False,
    ):
        if self.execute_error is not None:
            raise self.execute_error
        self.executed.append(code)
        self.execute_requests.append(
            {
                "code": code,
                "silent": silent,
                "store_history": store_history,
                "user_expressions": user_expressions,
                "allow_stdin": allow_stdin,
            }
        )
        return "msg-%d" % len(self.executed)

    async def get_iopub_msg(self, timeout=None):
        if not self.iopub:
            raise queue.Empty
        return self.iopub.pop(0)

    async def get_shell_msg(self, timeout=None):
        if not self.shell:
            raise queue.Empty
        return self.shell.pop(0)

    def stop_channels(self):
        self.channels_stopped = True


class FakeKernelManager:
    """A kernel manager that answers liveness and records signals."""

    def __init__(self, alive=True):
        self.alive = alive
        self.has_kernel = True
        self.interrupts = 0
        self.interrupt_error = None
        self.shutdowns = []

    async def is_alive(self):
        return self.alive

    async def interrupt_kernel(self):
        if self.interrupt_error is not None:
            raise self.interrupt_error
        self.interrupts += 1

    async def shutdown_kernel(self, now=False):
        self.shutdowns.append(now)
        self.has_kernel = False


def iopub(msg_type, content, parent="msg-1"):
    return {
        "msg_type": msg_type,
        "content": content,
        "parent_header": {"msg_id": parent},
    }


def shell_reply(content, parent="msg-1"):
    return {"content": content, "parent_header": {"msg_id": parent}}


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
        result = bridge.read_frame(io.BytesIO(bridge.encode_frame(msg)))
        self.assertEqual(result, msg)

    def test_read_frame_raises_on_clean_eof(self):
        with self.assertRaises(EOFError):
            bridge.read_frame(io.BytesIO(b""))

    def test_read_frame_rejects_oversized_declared_length(self):
        header = struct.pack(">I", bridge.MAX_FRAME + 1)
        with self.assertRaises(ValueError):
            bridge.read_frame(io.BytesIO(header + b"{}"))

    def test_encode_frame_rejects_oversized_payload(self):
        msg = {"type": "stream", "payload": {"text": "x" * (bridge.MAX_FRAME + 1)}}
        with self.assertRaises(ValueError):
            bridge.encode_frame(msg)


class TestDetachProtocolStream(unittest.TestCase):
    """The protocol must be unreachable from file descriptor 1."""

    def test_stray_writes_to_fd_one_never_reach_the_protocol(self):
        sys.stdout.flush()
        saved = os.dup(1)
        try:
            with tempfile.TemporaryFile() as transport:
                # Stand in for the pipe the transport reads.
                os.dup2(transport.fileno(), 1)
                stream = bridge.detach_protocol_stream()
                try:
                    # What a child process or a C extension would do.
                    os.write(1, b"stray")
                    stream.write(b"frame")
                    stream.flush()
                finally:
                    stream.close()
                transport.seek(0)
                self.assertEqual(transport.read(), b"frame")
        finally:
            os.dup2(saved, 1)
            os.close(saved)

    def test_returned_descriptor_is_not_inherited_by_children(self):
        sys.stdout.flush()
        saved = os.dup(1)
        try:
            with tempfile.TemporaryFile() as transport:
                os.dup2(transport.fileno(), 1)
                stream = bridge.detach_protocol_stream()
                try:
                    self.assertFalse(os.get_inheritable(stream.fileno()))
                finally:
                    stream.close()
        finally:
            os.dup2(saved, 1)
            os.close(saved)


class TestOutboundQueue(unittest.TestCase):
    """The queue reports pressure instead of refusing a user's output."""

    def test_accepts_beyond_the_high_water_mark(self):
        q = bridge.OutboundQueue(high_water_frames=2, high_water_bytes=1024)
        q.put(b"one")
        q.put(b"two")
        q.put(b"three")
        self.assertEqual(len(q.drain()), 3)

    def test_reports_pressure_on_frame_count(self):
        q = bridge.OutboundQueue(high_water_frames=2, high_water_bytes=1024)
        q.put(b"one")
        self.assertFalse(q.pressured())
        q.put(b"two")
        self.assertTrue(q.pressured())

    def test_reports_pressure_on_byte_total(self):
        q = bridge.OutboundQueue(high_water_frames=100, high_water_bytes=10)
        q.put(b"fivebytes")
        self.assertFalse(q.pressured())
        q.put(b"x")
        self.assertTrue(q.pressured())

    def test_drain_clears_pressure(self):
        q = bridge.OutboundQueue(high_water_frames=1, high_water_bytes=1024)
        q.put(b"one")
        self.assertTrue(q.pressured())
        q.drain()
        self.assertFalse(q.pressured())
        self.assertEqual(q.pending_bytes(), 0)

    def test_rejects_after_close(self):
        q = bridge.OutboundQueue()
        q.close()
        with self.assertRaises(RuntimeError):
            q.put(b"data")


class TestExecuteMapping(unittest.TestCase):
    """Correlation state, and the outcome the kernel's reply implies."""

    def test_is_complete_needs_reply_and_idle_but_not_busy(self):
        m = bridge.ExecuteMapping()
        self.assertFalse(m.is_complete())
        m.shell_reply = {"status": "ok"}
        self.assertFalse(m.is_complete())
        # A busy status that never arrived must not hang the execution.
        m.iopub_idle = True
        self.assertTrue(m.is_complete())

    def test_outcome_succeeded(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        self.assertEqual(m.outcome(), "succeeded")

    def test_outcome_failed_on_error_reply(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "ValueError"}
        self.assertEqual(m.outcome(), "failed")

    def test_outcome_succeeded_when_interrupt_lost_the_race(self):
        # The interrupt arrived, but the cell had already finished cleanly.
        # Reporting a cancellation here would be a lie about the user's result.
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "succeeded")

    def test_outcome_cancelled_when_interrupt_produced_keyboard_interrupt(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "KeyboardInterrupt"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "cancelled")

    def test_outcome_failed_when_interrupt_coincided_with_a_real_error(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "ZeroDivisionError"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "failed")

    def test_outcome_cancelled_on_abort_reply(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "abort"}
        self.assertEqual(m.outcome(), "cancelled")

    def test_outcome_without_a_reply_depends_on_the_interrupt(self):
        m = bridge.ExecuteMapping()
        self.assertEqual(m.outcome(), "failed")
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "cancelled")

    def test_reset_clears_all_state(self):
        m = bridge.ExecuteMapping()
        m.active_request_id = "req-1"
        m.active_msg_id = "msg-1"
        m.shell_reply = {"status": "ok"}
        m.iopub_busy = True
        m.iopub_idle = True
        m.interrupt_requested = True
        m.warned_message_types.add("clear_output")
        m.reset()
        self.assertIsNone(m.active_request_id)
        self.assertIsNone(m.active_msg_id)
        self.assertIsNone(m.shell_reply)
        self.assertFalse(m.iopub_busy)
        self.assertFalse(m.iopub_idle)
        self.assertFalse(m.interrupt_requested)
        self.assertEqual(m.warned_message_types, set())


class TestBridgeHandshake(unittest.TestCase):
    """Tests for the bridge handshake protocol."""

    @staticmethod
    def _hello(capabilities):
        return {
            "protocolVersion": 1,
            "type": "hello",
            "sessionId": "test-session",
            "generation": 1,
            "requestId": None,
            "sequence": 0,
            "payload": {
                "ownerToken": "token-123",
                "frameLimit": bridge.MAX_FRAME,
                "requiredCapabilities": capabilities,
            },
        }

    def test_hello_sets_session_and_sends_hello_ack(self):
        b, _ = make_bridge(initialized=False)
        message = self._hello(["execute", "interrupt", "restart", "shutdown"])
        b._validate_message(message)
        b._handle_hello(message)
        msgs = queued(b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "hello-ack")
        self.assertEqual(msgs[0]["sessionId"], "test-session")
        self.assertEqual(msgs[0]["payload"]["ownerToken"], "token-123")
        self.assertEqual(msgs[0]["payload"]["pid"], os.getpid())
        self.assertIn("execute", msgs[0]["payload"]["capabilities"])

    def test_hello_rejects_missing_capabilities(self):
        b, _ = make_bridge(initialized=False)
        message = self._hello(["execute", "interrupt", "restart", "shutdown", "stdin"])
        b._validate_message(message)
        b._handle_hello(message)
        msgs = queued(b)
        self.assertEqual(msgs[0]["type"], "fatal")
        self.assertIn("stdin", msgs[0]["payload"]["reason"])
        self.assertFalse(b._running)
        self.assertTrue(b._stop.is_set())

    def test_rejects_sequence_gap_and_session_change(self):
        b, _ = make_bridge(initialized=False)
        hello = self._hello([])
        b._validate_message(hello)
        b._handle_hello(hello)
        with self.assertRaises(bridge.ProtocolViolation):
            b._validate_message(
                {
                    "protocolVersion": 1,
                    "type": "shutdown",
                    "sessionId": "other-session",
                    "generation": 1,
                    "requestId": None,
                    "sequence": 2,
                    "payload": {},
                }
            )


class TestOutboundSequencing(unittest.TestCase):
    """The bridge sequence must describe frames that actually exist."""

    def test_sequence_increments_once_per_queued_frame(self):
        b, _ = make_bridge()
        b._send("accepted", {}, "req-1")
        b._send("accepted", {}, "req-2")
        self.assertEqual([m["sequence"] for m in queued(b)], [0, 1])

    def test_failed_encode_leaves_no_gap_in_the_sequence(self):
        b, _ = make_bridge()
        b._send("accepted", {}, "req-1")
        with self.assertRaises(ValueError):
            b._send("stream", {"stream": "stdout", "text": "x" * (bridge.MAX_FRAME + 1)}, "req-1")
        b._send("accepted", {}, "req-2")
        self.assertEqual([m["sequence"] for m in queued(b)], [0, 1])

    def test_fatal_before_a_session_falls_back_to_diagnostics(self):
        stderr = io.StringIO()
        b = bridge.ScientBridge(io.BytesIO(), io.BytesIO(), stderr)
        b._send_fatal("nothing to send on")
        self.assertEqual(queued(b), [])
        self.assertIn("nothing to send on", stderr.getvalue())


class TestBridgeIOPubMapping(unittest.TestCase):
    """Tests for IOPub message to protocol event mapping."""

    def setUp(self):
        self.b, self.stdout = make_bridge()

    def test_stream_maps_to_stream_event(self):
        self.b._handle_iopub("stream", {"name": "stdout", "text": "hello\n"}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "stream")
        self.assertEqual(msgs[0]["payload"]["stream"], "stdout")
        self.assertEqual(msgs[0]["payload"]["text"], "hello\n")
        self.assertEqual(msgs[0]["requestId"], "req-1")

    def test_unknown_stream_name_falls_back_to_stdout(self):
        self.b._handle_iopub("stream", {"name": "weird", "text": "x"}, "req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["stream"], "stdout")

    def test_display_png_maps_to_display_event(self):
        self.b._handle_iopub("display_data", {"data": {"image/png": "iVBORw0KGgo="}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["mediaType"], "image/png")
        self.assertEqual(msgs[0]["payload"]["data"], "iVBORw0KGgo=")

    def test_display_text_fallback(self):
        self.b._handle_iopub("execute_result", {"data": {"text/plain": "42"}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["mediaType"], "text/plain")
        self.assertEqual(msgs[0]["payload"]["text"], "42")

    def test_display_svg_maps_to_display_event(self):
        source = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>'
        self.b._handle_iopub(
            "display_data", {"data": {"image/svg+xml": source}}, "req-1"
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["mediaType"], "image/svg+xml")
        self.assertEqual(msgs[0]["payload"]["data"], source)

    def test_oversized_png_warns_instead_of_sending(self):
        oversized = "A" * (bridge.MAX_PNG_BASE64 + 1)
        self.b._handle_iopub("display_data", {"data": {"image/png": oversized}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_oversized_non_ascii_png_warns_instead_of_sending(self):
        # What a ``_repr_png_`` returning prose looks like: it is not base64 at
        # all, and half as many characters as the limit allows still encodes to
        # more bytes than the limit -- which an ASCII-only count would miss.
        oversized = "\u00e9" * (bridge.MAX_PNG_BASE64 // 2 + 1)
        self.b._handle_iopub("display_data", {"data": {"image/png": oversized}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_oversized_svg_warns_instead_of_sending(self):
        oversized = "é" * (bridge.MAX_SVG_TEXT // 2 + 1)
        self.b._handle_iopub(
            "display_data", {"data": {"image/svg+xml": oversized}}, "req-1"
        )
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_svg_that_expands_past_frame_limit_warns_instead_of_failing(self):
        self.b._peer_frame_limit = 1024
        source = "<svg>" + ("x" * 2000) + "</svg>"
        self.b._handle_iopub(
            "display_data", {"data": {"image/svg+xml": source}}, "req-1"
        )
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_error_maps_to_error_event(self):
        self.b._handle_iopub(
            "error",
            {"ename": "ValueError", "evalue": "bad", "traceback": ["line 1", "line 2"]},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "error")
        self.assertEqual(msgs[0]["payload"]["name"], "ValueError")
        self.assertEqual(msgs[0]["payload"]["value"], "bad")
        self.assertEqual(msgs[0]["payload"]["traceback"], ["line 1", "line 2"])

    def test_error_does_not_decide_the_outcome(self):
        # An exception the user caught and re-raised inside the cell still shows
        # up here; only the shell reply says whether the cell as a whole failed.
        self.b._mapping.shell_reply = {"status": "ok"}
        self.b._handle_iopub("error", {"ename": "ValueError", "evalue": "x"}, "req-1")
        self.assertEqual(self.b._mapping.outcome(), "succeeded")

    def test_status_busy_sets_mapping(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._handle_iopub("status", {"execution_state": "busy"}, "req-1")
        self.assertTrue(self.b._mapping.iopub_busy)

    def test_status_idle_sets_mapping(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._handle_iopub("status", {"execution_state": "idle"}, "req-1")
        self.assertTrue(self.b._mapping.iopub_idle)

    def test_unsupported_message_warns_once_per_execution(self):
        for _ in range(5):
            self.b._handle_iopub("clear_output", {}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["payload"]["code"], "runtime-warning")
        self.b._mapping.reset()
        self.b._handle_iopub("clear_output", {}, "req-2")
        self.assertEqual(len(queued(self.b)), 1)

    def test_update_display_and_clear_output_warn_separately(self):
        self.b._handle_iopub("update_display_data", {}, "req-1")
        self.b._handle_iopub("clear_output", {}, "req-1")
        self.assertEqual(len(queued(self.b)), 2)

    def test_blocked_stdin_reports_the_cause_the_user_can_act_on(self):
        self.b._handle_iopub(
            "error",
            {"ename": "StdinNotImplementedError", "evalue": "input not supported"},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "error")
        self.assertEqual(msgs[1]["type"], "warning")
        self.assertEqual(msgs[1]["payload"]["code"], "input-unsupported")

    def test_oversized_stream_truncates_with_warning(self):
        self.b._handle_iopub(
            "stream",
            {"name": "stdout", "text": "x" * (bridge.MAX_STREAM_TEXT + 100)},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "stream")
        self.assertLessEqual(
            len(msgs[0]["payload"]["text"].encode("utf-8")), bridge.MAX_STREAM_TEXT
        )
        self.assertEqual(msgs[1]["type"], "warning")
        self.assertEqual(msgs[1]["payload"]["code"], "output-truncated")

    def test_unsupported_media_types_are_named_rather_than_dropped(self):
        self.b._handle_iopub(
            "display_data",
            {"data": {"text/html": "<b>bold</b>"}},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["payload"]["code"], "runtime-warning")
        self.assertIn("text/html", msgs[0]["payload"]["detail"])


class TestBridgeExecute(unittest.IsolatedAsyncioTestCase):
    """Submitting work, and what happens when submitting fails."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.client = FakeKernelClient()
        self.manager = FakeKernelManager()
        self.b._kernel_client = self.client
        self.b._kernel_manager = self.manager

    async def asyncTearDown(self):
        task = self.b._execution_task
        if task is not None:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_accepts_and_starts_correlating(self):
        await self.b._handle_execute({"code": "1+1", "silent": False, "storeHistory": True}, "req-1")
        self.assertEqual(self.client.executed, ["1+1"])
        self.assertEqual(self.b._mapping.active_request_id, "req-1")
        msgs = decode_frames(self.stdout.getvalue())
        self.assertEqual(msgs[0]["type"], "accepted")
        self.assertEqual(msgs[0]["requestId"], "req-1")

    async def test_a_refused_submit_leaves_the_session_usable(self):
        self.client.execute_error = RuntimeError("shell channel is dead")
        with self.assertRaises(RuntimeError):
            await self.b._handle_execute({"code": "1+1"}, "req-1")
        # The slot is still free, so the next cell can run.
        self.assertIsNone(self.b._mapping.active_request_id)
        self.assertIsNone(self.b._execution_task)

    async def test_rejects_oversized_code(self):
        with self.assertRaises(bridge.ProtocolViolation):
            await self.b._handle_execute({"code": "x" * (bridge.MAX_CODE + 1)}, "req-1")
        self.assertEqual(self.client.executed, [])

    async def test_rejects_a_second_concurrent_execution(self):
        self.b._mapping.active_request_id = "req-1"
        with self.assertRaises(bridge.ProtocolViolation):
            await self.b._handle_execute({"code": "1"}, "req-2")


class TestBridgeVariables(unittest.IsolatedAsyncioTestCase):
    """Variable inspection is bounded, correlated and never enters history."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.b._kernel_manager = self.manager

    async def test_returns_a_bounded_snapshot_from_a_hidden_expression(self):
        encoded = json.dumps(
            {
                "variables": [
                    {
                        "name": "answer",
                        "typeName": "int",
                        "shape": None,
                        "size": None,
                        "preview": "42",
                    }
                ],
                "truncated": False,
            },
            separators=(",", ":"),
        )
        self.b._kernel_client = FakeKernelClient(
            shell=[
                shell_reply(
                    {
                        "status": "ok",
                        "user_expressions": {
                            "scient_variables": {
                                "status": "ok",
                                "data": {"text/plain": repr(encoded)},
                            }
                        },
                    }
                )
            ]
        )

        await self.b._handle_inspect_variables("variables-1")

        request = self.b._kernel_client.execute_requests[0]
        self.assertEqual(request["code"], "")
        self.assertTrue(request["silent"])
        self.assertFalse(request["store_history"])
        self.assertFalse(request["allow_stdin"])
        self.assertIn("scient_variables", request["user_expressions"])
        messages = queued(self.b)
        self.assertEqual(messages[0]["type"], "variables")
        self.assertEqual(messages[0]["requestId"], "variables-1")
        self.assertEqual(messages[0]["payload"]["variables"][0]["preview"], "42")
        self.assertIsNone(messages[0]["payload"]["error"])

    async def test_inspection_failure_is_nonfatal_and_bounded(self):
        self.b._kernel_client = FakeKernelClient(
            shell=[shell_reply({"status": "error", "ename": "RuntimeError"})]
        )
        await self.b._handle_inspect_variables("variables-1")
        message = queued(self.b)[0]
        self.assertEqual(message["type"], "variables")
        self.assertEqual(message["payload"]["variables"], [])
        self.assertIn("could not inspect", message["payload"]["error"])
        self.assertTrue(self.b._running)

    async def test_refuses_to_race_an_execution(self):
        self.b._kernel_client = FakeKernelClient()
        self.b._mapping.active_request_id = "run-1"
        with self.assertRaisesRegex(bridge.ProtocolViolation, "already active"):
            await self.b._handle_inspect_variables("variables-1")
        self.assertEqual(self.b._kernel_client.execute_requests, [])

    def test_summary_expression_never_calls_a_user_defined_repr(self):
        class Hostile:
            called = False

            def __repr__(self):
                Hostile.called = True
                raise RuntimeError("must not run")

        class ndarray:
            __module__ = "numpy"
            shape_called = False

            @property
            def shape(self):
                ndarray.shape_called = True
                raise RuntimeError("must not run")

            @property
            def size(self):
                ndarray.shape_called = True
                raise RuntimeError("must not run")

        namespace = {
            "answer": 42,
            "large_text": "x" * 10_000,
            "items": [1, 2, 3],
            "hostile": Hostile(),
            "spoofed_array": ndarray(),
        }
        decoded = json.loads(eval(bridge.VARIABLE_INSPECTION_EXPRESSION, namespace))
        by_name = {item["name"]: item for item in decoded["variables"]}
        self.assertFalse(Hostile.called)
        self.assertFalse(ndarray.shape_called)
        self.assertEqual(by_name["answer"]["preview"], "42")
        self.assertEqual(by_name["items"]["size"], 3)
        self.assertIsNone(by_name["hostile"]["preview"])
        self.assertIsNone(by_name["spoofed_array"]["shape"])
        self.assertIsNone(by_name["spoofed_array"]["size"])
        self.assertLessEqual(len(by_name["large_text"]["preview"]), 4096)


class TestBridgeCorrelation(unittest.IsolatedAsyncioTestCase):
    """The correlation loop's completion, ordering and liveness behaviour."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.b._kernel_manager = self.manager

    def _messages(self):
        return decode_frames(self.stdout.getvalue())

    async def test_completes_when_reply_and_idle_have_arrived(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub("status", {"execution_state": "busy"}),
                iopub("stream", {"name": "stdout", "text": "hi\n"}),
                iopub("status", {"execution_state": "idle"}),
            ],
            shell=[shell_reply({"status": "ok"})],
        )
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.active_msg_id = "msg-1"
        await self.b._correlate("req-1", "msg-1")
        types = [m["type"] for m in self._messages()]
        self.assertEqual(types, ["stream", "execution-complete"])
        self.assertEqual(self._messages()[-1]["payload"]["outcome"], "succeeded")
        self.assertIsNone(self.b._mapping.active_request_id)

    async def test_ignores_output_belonging_to_another_execution(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub("stream", {"name": "stdout", "text": "not mine\n"}, parent="msg-9"),
                iopub("status", {"execution_state": "idle"}),
            ],
            shell=[shell_reply({"status": "ok"})],
        )
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        self.assertEqual([m["type"] for m in self._messages()], ["execution-complete"])

    async def test_drains_late_output_after_an_execution_is_idle(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub(
                    "stream",
                    {"name": "stdout", "text": "late\n"},
                    parent="msg-old",
                )
            ]
        )
        self.b._recent_msg_ids["msg-old"] = "req-old"
        self.assertTrue(await self.b._drain_idle_iopub())
        await self.b._flush()
        messages = self._messages()
        self.assertEqual([message["type"] for message in messages], ["stream"])
        self.assertEqual(messages[0]["requestId"], "req-old")

    async def test_reports_session_loss_when_an_idle_kernel_exits(self):
        original_liveness = bridge.LIVENESS_INTERVAL
        original_poll = bridge.IDLE_POLL_INTERVAL
        bridge.LIVENESS_INTERVAL = 0.0
        bridge.IDLE_POLL_INTERVAL = 0.0
        try:
            self.manager.alive = False
            self.b._kernel_client = FakeKernelClient()
            await asyncio.wait_for(self.b._monitor_kernel(), timeout=0.1)
        finally:
            bridge.LIVENESS_INTERVAL = original_liveness
            bridge.IDLE_POLL_INTERVAL = original_poll
        messages = self._messages()
        self.assertEqual([message["type"] for message in messages], ["fatal"])
        self.assertIn("idle", messages[0]["payload"]["reason"])

    async def test_consumes_a_stale_shell_reply_without_completing(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[iopub("status", {"execution_state": "idle"})],
            shell=[shell_reply({"status": "ok"}, parent="msg-old"), shell_reply({"status": "error", "ename": "ValueError"})],
        )
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        self.assertEqual(self._messages()[-1]["payload"]["outcome"], "failed")

    async def test_reports_session_loss_when_the_kernel_exits(self):
        original = bridge.LIVENESS_INTERVAL
        bridge.LIVENESS_INTERVAL = 0.0
        try:
            self.manager.alive = False
            self.b._kernel_client = FakeKernelClient()
            self.b._mapping.active_request_id = "req-1"
            await self.b._correlate("req-1", "msg-1")
        finally:
            bridge.LIVENESS_INTERVAL = original
        msgs = self._messages()
        # Loss is reported about the session, so there is no execution outcome
        # to claim on the way out.
        self.assertEqual([m["type"] for m in msgs], ["fatal"])
        self.assertIn("exited", msgs[0]["payload"]["reason"])
        self.assertFalse(self.b._running)

    async def test_a_broken_channel_is_reported_as_session_loss(self):
        class ExplodingClient(FakeKernelClient):
            async def get_iopub_msg(self, timeout=None):
                raise OSError("zmq socket closed")

        self.b._kernel_client = ExplodingClient()
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        msgs = self._messages()
        self.assertEqual(msgs[0]["type"], "fatal")
        self.assertIn("zmq socket closed", msgs[0]["payload"]["reason"])

    async def test_flushes_under_pressure_instead_of_dropping_output(self):
        chatty = [iopub("stream", {"name": "stdout", "text": "line %d\n" % i}) for i in range(40)]
        chatty.append(iopub("status", {"execution_state": "idle"}))
        self.b._outbound = bridge.OutboundQueue(high_water_frames=4, high_water_bytes=1 << 20)
        self.b._kernel_client = FakeKernelClient(chatty, [shell_reply({"status": "ok"})])
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        msgs = self._messages()
        streams = [m for m in msgs if m["type"] == "stream"]
        self.assertEqual(len(streams), 1)
        self.assertEqual(
            streams[0]["payload"]["text"],
            "".join("line %d\n" % index for index in range(40)),
        )
        self.assertEqual([m["sequence"] for m in msgs], list(range(len(msgs))))


class TestBridgeInterrupt(unittest.IsolatedAsyncioTestCase):
    """Interrupt answers whether the signal landed, not what the code did."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.b._kernel_manager = self.manager
        self.b._kernel_client = FakeKernelClient()
        self._saved = (bridge.INTERRUPT_BUSY_TIMEOUT, bridge.INTERRUPT_SETTLE_TIMEOUT)
        bridge.INTERRUPT_BUSY_TIMEOUT = 0.05
        bridge.INTERRUPT_SETTLE_TIMEOUT = 0.05

    def tearDown(self):
        bridge.INTERRUPT_BUSY_TIMEOUT, bridge.INTERRUPT_SETTLE_TIMEOUT = self._saved

    async def test_nothing_to_stop_is_terminal(self):
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "terminal")

    async def test_a_different_execution_is_rejected(self):
        self.b._mapping.active_request_id = "req-active"
        await self.b._handle_interrupt("req-other")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "rejected")
        self.assertEqual(self.manager.interrupts, 0)

    async def test_a_dead_kernel_is_terminal(self):
        self.manager.alive = False
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "terminal")
        self.assertEqual(self.manager.interrupts, 0)

    async def test_an_undeliverable_signal_is_rejected(self):
        self.manager.interrupt_error = RuntimeError("no such process")
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "rejected")
        self.assertFalse(self.b._mapping.interrupt_requested)

    async def test_a_signal_the_execution_answers_is_interrupted(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True

        async def settle():
            await asyncio.sleep(0)
            self.b._mapping.reset()

        settling = asyncio.ensure_future(settle())
        await self.b._handle_interrupt("req-1")
        await settling
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "interrupted")
        self.assertEqual(self.manager.interrupts, 1)

    async def test_a_signal_the_execution_ignores_is_a_timeout(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "timeout")
        self.assertEqual(self.manager.interrupts, 1)

    async def test_work_that_ends_while_waiting_for_busy_is_terminal(self):
        self.b._mapping.active_request_id = "req-1"

        async def finish():
            await asyncio.sleep(0)
            self.b._mapping.reset()

        finishing = asyncio.ensure_future(finish())
        await self.b._handle_interrupt("req-1")
        await finishing
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "terminal")
        self.assertEqual(self.manager.interrupts, 0)

    async def test_a_missed_busy_status_still_signals(self):
        # Refusing here would strand a user whose runaway loop never published
        # a busy status; a missed status message is the likelier explanation.
        self.b._mapping.active_request_id = "req-1"
        await self.b._handle_interrupt("req-1")
        self.assertEqual(self.manager.interrupts, 1)


class TestBridgeLifecycle(unittest.IsolatedAsyncioTestCase):
    """Restart and shutdown, and what they say about work in flight."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.client = FakeKernelClient()
        self.b._kernel_manager = self.manager
        self.b._kernel_client = self.client

    async def test_cancelling_in_flight_work_reports_the_given_outcome(self):
        async def forever():
            await asyncio.Event().wait()

        self.b._mapping.active_request_id = "req-1"
        self.b._execution_task = asyncio.ensure_future(forever())
        await asyncio.sleep(0)
        await self.b._cancel_execution_task(emit_completion=True, outcome="cancelled")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "execution-complete")
        self.assertEqual(msgs[0]["payload"]["outcome"], "cancelled")
        self.assertIsNone(self.b._execution_task)

    async def test_cancelling_can_stay_silent_when_the_session_is_lost(self):
        self.b._mapping.active_request_id = "req-1"
        await self.b._cancel_execution_task(emit_completion=False)
        self.assertEqual(queued(self.b), [])

    async def test_shutdown_stops_the_kernel_and_confirms(self):
        await self.b._shutdown_kernel()
        self.assertTrue(self.client.channels_stopped)
        self.assertEqual(self.manager.shutdowns, [False])
        self.assertEqual(queued(self.b)[-1]["type"], "shutdown-complete")

    async def test_shutdown_escalates_when_the_kernel_will_not_go(self):
        class StubbornManager(FakeKernelManager):
            async def shutdown_kernel(self, now=False):
                self.shutdowns.append(now)
                if not now:
                    raise RuntimeError("no reply")
                self.has_kernel = False

        self.b._kernel_manager = StubbornManager()
        await self.b._shutdown_kernel()
        self.assertEqual(self.b._kernel_manager.shutdowns, [False, True])
        self.assertEqual(queued(self.b)[-1]["type"], "shutdown-complete")

    async def test_shutdown_does_not_claim_success_when_forced_stop_fails(self):
        class UnstoppableManager(FakeKernelManager):
            async def shutdown_kernel(self, now=False):
                self.shutdowns.append(now)
                raise RuntimeError("still alive")

        self.b._kernel_manager = UnstoppableManager()
        self.b._mapping.active_request_id = "req-1"
        with self.assertRaisesRegex(RuntimeError, "did not stop"):
            await self.b._shutdown_kernel()
        self.assertEqual(queued(self.b), [])

    async def test_restart_does_not_claim_cancellation_when_replacement_fails(self):
        class BrokenRestartManager(FakeKernelManager):
            async def restart_kernel(self, now=False):
                raise RuntimeError("cannot restart")

        self.b._kernel_manager = BrokenRestartManager()
        self.b._mapping.active_request_id = "req-1"
        with self.assertRaisesRegex(RuntimeError, "cannot restart"):
            await self.b._restart_kernel(2)
        self.assertEqual(queued(self.b), [])
        self.assertEqual(self.b._generation, 1)

    async def test_restart_advances_the_generation_in_the_envelope_only(self):
        class RestartingManager(FakeKernelManager):
            def __init__(self):
                super().__init__()
                self.provisioner = type("P", (), {"pid": 4321})()

            async def restart_kernel(self, now=False):
                self.restarted = now

            def client(self):
                return RestartingClient()

        class RestartingClient(FakeKernelClient):
            def start_channels(self):
                pass

            async def wait_for_ready(self, timeout=None):
                pass

        self.b._kernel_manager = RestartingManager()
        self.b._mapping.active_request_id = "req-1"
        await self.b._restart_kernel(2)
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "execution-complete")
        self.assertEqual(msgs[0]["payload"]["outcome"], "cancelled")
        self.assertEqual(msgs[1]["type"], "restarted")
        self.assertEqual(msgs[1]["generation"], 2)
        self.assertEqual(msgs[1]["payload"], {"kernelPid": 4321})


class TestInboundReader(unittest.IsolatedAsyncioTestCase):
    """The reader hands frames over one at a time and reports how it ended."""

    async def test_delivers_frames_then_eof(self):
        data = bridge.encode_frame({"type": "hello"}) + bridge.encode_frame({"type": "shutdown"})
        reader = bridge.InboundReader(io.BytesIO(data), asyncio.get_running_loop())
        reader.start()
        self.assertEqual(await reader.next(), ("frame", {"type": "hello"}))
        self.assertEqual(await reader.next(), ("frame", {"type": "shutdown"}))
        self.assertEqual(await reader.next(), ("eof", None))

    async def test_reports_a_malformed_frame_as_an_error(self):
        data = struct.pack(">I", 4) + b"nope"
        reader = bridge.InboundReader(io.BytesIO(data), asyncio.get_running_loop())
        reader.start()
        kind, value = await reader.next()
        self.assertEqual(kind, "error")
        self.assertIsInstance(value, ValueError)

    async def test_does_not_read_ahead_of_the_loop(self):
        data = b"".join(bridge.encode_frame({"n": n}) for n in range(3))
        stream = io.BytesIO(data)
        reader = bridge.InboundReader(stream, asyncio.get_running_loop())
        reader.start()
        first = await reader.next()
        self.assertEqual(first, ("frame", {"n": 0}))
        # One frame is in flight at most, so the stream is not drained ahead.
        await asyncio.sleep(0.05)
        self.assertLess(stream.tell(), len(data))


class TestRunLoop(unittest.IsolatedAsyncioTestCase):
    """End-to-end command handling over the framed protocol."""

    def _script(self, *messages):
        return io.BytesIO(b"".join(bridge.encode_frame(m) for m in messages))

    async def test_handshake_then_shutdown_writes_a_clean_stream(self):
        stdin = self._script(
            {
                "protocolVersion": 1,
                "type": "hello",
                "sessionId": "s-1",
                "generation": 1,
                "requestId": None,
                "sequence": 0,
                "payload": {
                    "ownerToken": "tok",
                    "frameLimit": bridge.MAX_FRAME,
                    "requiredCapabilities": ["execute"],
                },
            },
            {
                "protocolVersion": 1,
                "type": "shutdown",
                "sessionId": "s-1",
                "generation": 1,
                "requestId": None,
                "sequence": 1,
                "payload": {},
            },
        )
        stdout = io.BytesIO()
        b = bridge.ScientBridge(stdin, stdout, io.StringIO())
        self.assertEqual(await b.run(), 0)
        msgs = decode_frames(stdout.getvalue())
        self.assertEqual([m["type"] for m in msgs], ["hello-ack", "shutdown-complete"])
        self.assertEqual([m["sequence"] for m in msgs], [0, 1])

    async def test_a_protocol_violation_ends_with_a_fatal(self):
        stdin = self._script(
            {
                "protocolVersion": 1,
                "type": "execute",
                "sessionId": "s-1",
                "generation": 1,
                "requestId": "req-1",
                "sequence": 0,
                "payload": {"code": "1"},
            }
        )
        stdout = io.BytesIO()
        b = bridge.ScientBridge(stdin, stdout, io.StringIO())
        b._session_id = "s-1"
        await b.run()
        msgs = decode_frames(stdout.getvalue())
        self.assertEqual(msgs[-1]["type"], "fatal")
        self.assertIn("hello must be the first command", msgs[-1]["payload"]["reason"])

    async def test_a_stop_request_ends_the_loop(self):
        # Nothing will ever arrive on this stream, so only the stop can end it.
        stdin = os.pipe()
        reader = os.fdopen(stdin[0], "rb")
        writer = os.fdopen(stdin[1], "wb")
        b = bridge.ScientBridge(reader, io.BytesIO(), io.StringIO())
        running = asyncio.ensure_future(b.run())
        await asyncio.sleep(0.05)
        b._request_stop()
        self.assertEqual(await asyncio.wait_for(running, timeout=5), 0)
        writer.close()


class TestProcessExit(unittest.TestCase):
    """Stopping the bridge must exit the process, not abort it.

    Only a real subprocess can show this.  The inbound reader is a daemon
    thread parked in a blocking read, so it holds ``sys.stdin``'s buffered
    reader lock, and what that costs only appears once the interpreter shuts
    down -- long after an in-process ``run`` has returned.
    """

    @unittest.skipIf(os.name == "nt", "SIGTERM is not a graceful stop on Windows.")
    def test_a_stopped_process_exits_cleanly_while_the_reader_is_parked(self):
        process = subprocess.Popen(
            [sys.executable, bridge.__file__],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            hello = {
                "protocolVersion": 1,
                "type": "hello",
                "sessionId": "exit-session",
                "generation": 1,
                "requestId": None,
                "sequence": 0,
                "payload": {
                    "ownerToken": "token-123",
                    "frameLimit": bridge.MAX_FRAME,
                    "requiredCapabilities": ["execute"],
                },
            }
            process.stdin.write(bridge.encode_frame(hello))
            process.stdin.flush()
            # The acknowledgement is the readiness signal: the loop cannot have
            # answered before it installed the signal handlers below.
            self.assertEqual(bridge.read_frame(process.stdout)["type"], "hello-ack")
            process.send_signal(signal.SIGTERM)
            # stdin stays open on purpose.  Closing it would end the parked read
            # and release the very lock this test exists to survive.
            self.assertEqual(process.wait(timeout=30), 0)
            self.assertNotIn("Fatal Python error", process.stderr.read().decode("utf-8"))
        finally:
            process.kill()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
            process.wait(timeout=30)


if __name__ == "__main__":
    unittest.main()
