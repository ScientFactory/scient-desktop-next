#!/usr/bin/env python3
"""Scient compute bridge for Jupyter kernels.

A single-file sidecar that manages one Jupyter kernel and speaks the Scient
bridge protocol over framed stdin/stdout.  Uses only the standard library
plus ``jupyter_client``.

Protocol: every message is a 4-byte big-endian length prefix followed by a
UTF-8 JSON payload conforming to the Phase 1 envelope::

    {"protocolVersion": 1, "type": "...", "sessionId": "...",
     "generation": 1, "requestId": null, "sequence": 0, "payload": {...}}
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import struct
import sys
from typing import Any, Optional, ReadOnly

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = 1
FRAME_HEADER = struct.Struct(">I")

MAX_FRAME = 16 * 1024 * 1024
MAX_STREAM_TEXT = 256 * 1024
MAX_TRACEBACK_LINES = 200
MAX_TRACEBACK_LINE = 4096
MAX_ERROR_NAME = 256
MAX_ERROR_VALUE = 16 * 1024
MAX_PNG_BASE64 = 11 * 1024 * 1024
MAX_OUTBOUND_FRAMES = 64
MAX_OUTBOUND_BYTES = 24 * 1024 * 1024

STARTUP_TIMEOUT = 30
INTERRUPT_RESPONSE_TIMEOUT = 10
SHUTDOWN_TIMEOUT = 5

# ---------------------------------------------------------------------------
# Framed I/O
# ---------------------------------------------------------------------------


def _read_exact(n: int, stream: Any) -> bytes:
    """Read exactly *n* bytes from *stream* (a binary file object)."""
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            raise EOFError("Stream ended before requested bytes were read.")
        data += chunk
    return data


def read_frame(stream: Any) -> Optional[dict]:
    """Read one framed JSON message. Returns None on clean EOF."""
    header = _read_exact(4, stream)
    (length,) = FRAME_HEADER.unpack(header)
    if length > MAX_FRAME:
        raise ValueError(f"Frame length {length} exceeds limit {MAX_FRAME}.")
    payload = _read_exact(length, stream)
    return json.loads(payload.decode("utf-8"))


def encode_frame(message: dict) -> bytes:
    """Encode a message as a framed payload."""
    payload = json.dumps(message).encode("utf-8")
    if len(payload) > MAX_FRAME:
        raise ValueError(f"Encoded payload {len(payload)} exceeds limit {MAX_FRAME}.")
    return FRAME_HEADER.pack(len(payload)) + payload


# ---------------------------------------------------------------------------
# Bounded outbound queue
# ---------------------------------------------------------------------------


class BoundedOutboundQueue:
    """A queue that fails when count or byte capacity is exceeded."""

    def __init__(self, max_frames: int = MAX_OUTBOUND_FRAMES,
                 max_bytes: int = MAX_OUTBOUND_BYTES) -> None:
        self._queue: list[bytes] = []
        self._bytes = 0
        self._max_frames = max_frames
        self._max_bytes = max_bytes
        self._closed = False

    def put(self, frame: bytes) -> None:
        if self._closed:
            raise RuntimeError("Queue is closed.")
        if len(self._queue) >= self._max_frames:
            raise RuntimeError(
                f"Outbound queue full: {len(self._queue)}/{self._max_frames} frames."
            )
        if self._bytes + len(frame) > self._max_bytes:
            raise RuntimeError(
                f"Outbound queue full: {self._bytes + len(frame)}/{self._max_bytes} bytes."
            )
        self._queue.append(frame)
        self._bytes += len(frame)

    def drain(self) -> list[bytes]:
        frames = self._queue
        self._queue = []
        self._bytes = 0
        return frames

    def close(self) -> None:
        self._closed = True


# ---------------------------------------------------------------------------
# Execute correlation
# ---------------------------------------------------------------------------


class ExecuteMapping:
    """Tracks one active execution's shell reply and IOPub idle state."""

    def __init__(self) -> None:
        self.active_request_id: Optional[str] = None
        self.active_msg_id: Optional[str] = None
        self.shell_reply: Optional[dict] = None
        self.iopub_busy: bool = False
        self.iopub_idle: bool = False
        self.error_observed: bool = False
        self.interrupt_requested: bool = False

    def is_complete(self) -> bool:
        return self.shell_reply is not None and self.iopub_idle and self.iopub_busy

    def outcome(self) -> str:
        if self.shell_reply and self.shell_reply.get("status") == "error":
            return "failed"
        if self.error_observed:
            return "failed"
        if self.interrupt_requested and self.iopub_idle:
            return "cancelled"
        return "succeeded"

    def reset(self) -> None:
        self.active_request_id = None
        self.active_msg_id = None
        self.shell_reply = None
        self.iopub_busy = False
        self.iopub_idle = False
        self.error_observed = False
        self.interrupt_requested = False


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class ScientBridge:
    """Manages one Jupyter kernel and speaks the bridge protocol."""

    def __init__(self, stdin_stream: Any, stdout_stream: Any,
                 stderr_stream: Any = None) -> None:
        self._stdin = stdin_stream
        self._stdout = stdout_stream
        self._stderr = stderr_stream or sys.stderr
        self._outbound = BoundedOutboundQueue()
        self._mapping = ExecuteMapping()
        self._session_id: Optional[str] = None
        self._generation = 1
        self._owner_token: Optional[str] = None
        self._server_sequence = 0
        self._bridge_sequence = 0
        self._kernel_manager: Any = None
        self._kernel_client: Any = None
        self._kernel_pid: Optional[int] = None
        self._running = True
        self._capabilities = ["execute", "interrupt", "restart", "shutdown"]

    # -- Message helpers --------------------------------------------------

    def _make_message(self, msg_type: str, payload: dict,
                      request_id: Optional[str] = None) -> dict:
        msg = {
            "protocolVersion": PROTOCOL_VERSION,
            "type": msg_type,
            "sessionId": self._session_id,
            "generation": self._generation,
            "requestId": request_id,
            "sequence": self._bridge_sequence,
            "payload": payload,
        }
        self._bridge_sequence += 1
        return msg

    def _send(self, msg_type: str, payload: dict,
              request_id: Optional[str] = None) -> None:
        msg = self._make_message(msg_type, payload, request_id)
        self._outbound.put(encode_frame(msg))

    def _send_warning(self, code: str, detail: Optional[str] = None,
                      request_id: Optional[str] = None) -> None:
        self._send("warning", {"code": code, "detail": detail}, request_id)

    def _send_fatal(self, reason: str) -> None:
        self._send("fatal", {"reason": reason[:4096]})

    def _flush(self) -> None:
        for frame in self._outbound.drain():
            self._stdout.buffer.write(frame)
        self._stdout.buffer.flush()

    def _diag(self, message: str) -> None:
        if self._stderr:
            self._stderr.write(message[:1024] + "\n")
            self._stderr.flush()

    # -- Handshake --------------------------------------------------------

    def _handle_hello(self, payload: dict) -> None:
        self._session_id = payload.get("sessionId") or "unknown"
        self._owner_token = payload.get("ownerToken")
        required = set(payload.get("requiredCapabilities", []))
        offered = set(self._capabilities)
        missing = required - offered
        if missing:
            self._send_fatal(f"Missing capabilities: {','.join(sorted(missing))}")
            self._flush()
            self._running = False
            return
        self._send("hello-ack", {
            "ownerToken": self._owner_token,
            "pid": os.getpid(),
            "platform": sys.platform,
            "capabilities": self._capabilities,
        })

    # -- Kernel management ------------------------------------------------

    async def _start_kernel(self, working_directory: str) -> None:
        from jupyter_client import AsyncKernelManager
        self._kernel_manager = AsyncKernelManager()
        await self._kernel_manager.start_kernel(cwd=working_directory)
        self._kernel_client = self._kernel_manager.client()
        self._kernel_client.start_channels()
        await self._kernel_client.wait_for_ready(timeout=STARTUP_TIMEOUT)
        # Get kernel info for language identity.
        info = await self._kernel_client.get_kernel_info()
        # Try to obtain the kernel PID.
        try:
            self._kernel_pid = self._kernel_manager.get_kernel_pid()
        except Exception:
            self._kernel_pid = None
        lang_info = info.get("language_info", {}) if info else {}
        self._send("kernel-ready", {
            "kernelPid": self._kernel_pid or 0,
            "languageId": lang_info.get("name", "python"),
            "languageVersion": lang_info.get("version", "unknown"),
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": self._capabilities,
        })

    async def _restart_kernel(self) -> None:
        if self._kernel_manager is None:
            self._send_fatal("No kernel to restart.")
            return
        # Cancel any active execution.
        if self._mapping.active_request_id:
            self._send("execution-complete",
                       {"outcome": "cancelled"},
                       self._mapping.active_request_id)
        self._mapping.reset()
        await self._kernel_manager.restart_kernel(now=True)
        self._kernel_client = self._kernel_manager.client()
        self._kernel_client.start_channels()
        await self._kernel_client.wait_for_ready(timeout=STARTUP_TIMEOUT)
        try:
            self._kernel_pid = self._kernel_manager.get_kernel_pid()
        except Exception:
            self._kernel_pid = None
        self._generation += 1
        self._send("restarted", {
            "kernelPid": self._kernel_pid or 0,
            "generation": self._generation,
        })

    async def _shutdown_kernel(self) -> None:
        if self._mapping.active_request_id:
            self._send("execution-complete",
                       {"outcome": "cancelled"},
                       self._mapping.active_request_id)
        self._mapping.reset()
        if self._kernel_client:
            self._kernel_client.stop_channels()
        if self._kernel_manager:
            try:
                await asyncio.wait_for(
                    self._kernel_manager.shutdown_kernel(now=False),
                    timeout=SHUTDOWN_TIMEOUT,
                )
            except asyncio.TimeoutError:
                try:
                    await self._kernel_manager.shutdown_kernel(now=True)
                except Exception:
                    pass
        self._send("shutdown-complete", {})

    # -- Execute ----------------------------------------------------------

    async def _handle_execute(self, payload: dict, request_id: str) -> None:
        code = payload.get("code", "")
        silent = payload.get("silent", False)
        store_history = payload.get("storeHistory", True)

        if self._mapping.active_request_id is not None:
            self._send_fatal("An execution is already active.")
            return

        self._mapping.active_request_id = request_id
        msg_id = self._kernel_client.execute(
            code, silent=silent, store_history=store_history,
            allow_stdin=False,
        )
        self._mapping.active_msg_id = msg_id
        self._send("accepted", {}, request_id)

        # Read IOPub and shell channels until completion.
        await self._correlate(request_id, msg_id)

    async def _correlate(self, request_id: str, msg_id: str) -> None:
        """Read IOPub and shell channels until the execution completes."""
        while not self._mapping.is_complete():
            # Check IOPub first (authoritative for output ordering).
            try:
                iopub_msg = await asyncio.wait_for(
                    self._kernel_client.get_iopub_msg(timeout=1), timeout=1
                )
            except (asyncio.TimeoutError, Exception):
                iopub_msg = None

            if iopub_msg:
                parent_id = iopub_msg.get("parent_header", {}).get("msg_id")
                msg_type = iopub_msg.get("msg_type")
                content = iopub_msg.get("content", {})

                if parent_id == msg_id:
                    await self._handle_iopub(msg_type, content, request_id)
                elif parent_id is None:
                    # Parentless output.
                    await self._handle_iopub(msg_type, content, None)
                # Unknown parent: ignore kernel-global chatter.

            # Check shell channel.
            if self._mapping.shell_reply is None:
                try:
                    shell_msg = await asyncio.wait_for(
                        self._kernel_client.get_shell_msg(timeout=1), timeout=1
                    )
                except (asyncio.TimeoutError, Exception):
                    shell_msg = None

                if shell_msg and shell_msg.get("parent_header", {}).get("msg_id") == msg_id:
                    self._mapping.shell_reply = shell_msg.get("content", {})

            self._flush()

        # Emit terminal event.
        self._send("execution-complete",
                   {"outcome": self._mapping.outcome()},
                   request_id)
        self._mapping.reset()

    async def _handle_iopub(self, msg_type: str, content: dict,
                            request_id: Optional[str]) -> None:
        if msg_type == "stream":
            stream_name = content.get("name", "stdout")
            text = content.get("text", "")
            truncated = False
            if len(text.encode("utf-8")) > MAX_STREAM_TEXT:
                text = text[:MAX_STREAM_TEXT]
                truncated = True
            self._send("stream", {"stream": stream_name, "text": text}, request_id)
            if truncated:
                self._send_warning("output-truncated", "Stream text exceeded limit.",
                                   request_id)

        elif msg_type == "execute_result" or msg_type == "display_data":
            data = content.get("data", {})
            if "image/png" in data:
                png_b64 = data["image/png"]
                if len(png_b64) > MAX_PNG_BASE64:
                    self._send_warning("output-truncated", "PNG exceeded limit.",
                                       request_id)
                else:
                    self._send("display", {"mediaType": "image/png", "data": png_b64},
                               request_id)
            elif "text/plain" in data:
                text = data["text/plain"]
                if len(text.encode("utf-8")) > MAX_STREAM_TEXT:
                    text = text[:MAX_STREAM_TEXT]
                    self._send_warning("output-truncated", "Text display exceeded limit.",
                                       request_id)
                self._send("display", {"mediaType": "text/plain", "text": text},
                           request_id)
            # Ignore HTML, SVG, JavaScript, widgets, comms, unknown MIME.

        elif msg_type == "error":
            self._mapping.error_observed = True
            name = content.get("ename", "UnknownError")[:MAX_ERROR_NAME]
            value = content.get("evalue", "")[:MAX_ERROR_VALUE]
            traceback = content.get("traceback", [])
            traceback = [t[:MAX_TRACEBACK_LINE] for t in traceback[:MAX_TRACEBACK_LINES]]
            self._send("error", {"name": name, "value": value, "traceback": traceback},
                       request_id)

        elif msg_type == "status":
            status = content.get("execution_state")
            if status == "busy":
                self._mapping.iopub_busy = True
            elif status == "idle":
                self._mapping.iopub_idle = True

        elif msg_type == "update_display_data" or msg_type == "clear_output":
            self._send_warning("runtime-warning",
                               f"{msg_type} is not supported in Phase 2.",
                               request_id)

        elif msg_type == "input_request":
            # Immediately answer EOF; never wait for a client.
            self._send_warning("input-unsupported", "stdin is not supported.",
                               request_id)

    # -- Interrupt --------------------------------------------------------

    async def _handle_interrupt(self, request_id: str) -> None:
        if self._mapping.active_request_id is None:
            # No active execution: benign completion race.
            self._send("interrupt-result", {"result": "terminal"}, request_id)
            return
        if self._mapping.active_request_id != request_id:
            self._send("interrupt-result", {"result": "rejected"}, request_id)
            return

        self._mapping.interrupt_requested = True
        try:
            self._kernel_manager.interrupt_kernel()
        except Exception:
            self._send("interrupt-result", {"result": "rejected"}, request_id)
            return

        self._send("interrupt-result", {"result": "interrupted"}, request_id)

    # -- Command dispatch -------------------------------------------------

    async def _dispatch(self, message: dict) -> None:
        msg_type = message.get("type")
        payload = message.get("payload", {})
        request_id = message.get("requestId")

        if msg_type == "hello":
            self._handle_hello(payload)
        elif msg_type == "start-kernel":
            await self._start_kernel(payload.get("workingDirectory", os.getcwd()))
        elif msg_type == "execute":
            if request_id:
                await self._handle_execute(payload, request_id)
        elif msg_type == "interrupt":
            if request_id:
                await self._handle_interrupt(request_id)
        elif msg_type == "restart":
            await self._restart_kernel()
        elif msg_type == "shutdown":
            await self._shutdown_kernel()
            self._running = False
        else:
            self._send_fatal(f"Unknown command type: {msg_type}")

        self._flush()

    # -- Main loop --------------------------------------------------------

    async def _watch_stdin(self) -> None:
        """Watch for stdin EOF (parent death) in a background thread."""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, self._stdin.buffer.read, 0)
        except Exception:
            pass

    async def run(self) -> int:
        """Main bridge loop. Returns exit code."""
        try:
            while self._running:
                try:
                    message = await asyncio.get_event_loop().run_in_executor(
                        None, read_frame, self._stdin
                    )
                except EOFError:
                    # Parent died: clean up and exit.
                    self._diag("stdin EOF: parent disconnected.")
                    break
                except Exception as e:
                    self._send_fatal(f"Protocol error: {e}")
                    self._flush()
                    break

                if message is None:
                    break

                await self._dispatch(message)

        except KeyboardInterrupt:
            self._diag("Interrupted.")
        finally:
            # Clean up kernel.
            if self._kernel_client:
                try:
                    self._kernel_client.stop_channels()
                except Exception:
                    pass
            if self._kernel_manager:
                try:
                    await asyncio.wait_for(
                        self._kernel_manager.shutdown_kernel(now=True),
                        timeout=SHUTDOWN_TIMEOUT,
                    )
                except Exception:
                    pass
            self._flush()

        return 0


def main() -> int:
    bridge = ScientBridge(sys.stdin, sys.stdout)
    return asyncio.run(bridge.run())


if __name__ == "__main__":
    sys.exit(main())
