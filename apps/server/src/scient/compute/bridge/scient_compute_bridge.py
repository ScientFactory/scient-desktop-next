#!/usr/bin/env python3
"""Scient compute bridge for one directly selected Python interpreter.

The bridge speaks a length-prefixed JSON protocol on stdout and reserves stderr
for bounded diagnostics.  It uses the selected interpreter itself to launch
``ipykernel``; global kernelspec selection never decides which Python runs user
code.

Two invariants shape almost everything below.

The first is that the protocol stream must never be corrupted.  A kernel is a
child process, and anything it -- or a ``subprocess.run`` a user's cell makes,
or a C extension's ``printf`` -- writes straight to file descriptor 1 would land
in the middle of a frame and desynchronize the transport permanently.  So the
bridge moves the protocol off fd 1 before it does anything else and points the
original descriptor at ``/dev/null``.

The second is that a message the kernel already produced can never be refused.
The bridge queues frames without a hard cap and flushes on a high-water mark,
so back-pressure slows the producer instead of dropping a user's output.
"""

from __future__ import annotations

import asyncio
import ast
import contextlib
import json
import os
import queue
import signal
import struct
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, Optional, TextIO

PROTOCOL_VERSION = 1
FRAME_HEADER = struct.Struct(">I")

MAX_FRAME = 16 * 1024 * 1024
MAX_CODE = 1024 * 1024
MAX_STREAM_TEXT = 256 * 1024
MAX_TRACEBACK_LINES = 200
MAX_TRACEBACK_LINE = 4096
MAX_ERROR_NAME = 256
MAX_ERROR_VALUE = 16 * 1024
MAX_PNG_BASE64 = 11 * 1024 * 1024
MAX_SVG_TEXT = 8 * 1024 * 1024
MAX_DETAIL = 4096
MAX_DIAGNOSTIC = 1024

# Flush once this much is pending rather than refusing a frame.  Together with
# ``MAX_FRAME`` this bounds queued memory: at most the high-water mark plus the
# one frame that crossed it.
OUTBOUND_HIGH_WATER_BYTES = 8 * 1024 * 1024
OUTBOUND_HIGH_WATER_FRAMES = 256

# How many iopub messages one drain pass takes before yielding, so a chatty cell
# cannot starve the flush and liveness checks that share this loop.
MAX_IOPUB_BATCH = 256

STARTUP_TIMEOUT = 30
SHUTDOWN_TIMEOUT = 5
IDLE_POLL_INTERVAL = 0.02
LIVENESS_INTERVAL = 1.0
INTERRUPT_BUSY_TIMEOUT = 2.0
INTERRUPT_SETTLE_TIMEOUT = 2.0
INSPECTION_TIMEOUT = 5.0

MAX_VARIABLES = 200
MAX_VARIABLE_NAME = 256
MAX_VARIABLE_TYPE = 256
MAX_VARIABLE_TEXT = 4096
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991

SERVER_MESSAGE_TYPES = {
    "hello",
    "start-kernel",
    "execute",
    "interrupt",
    "inspect-variables",
    "restart",
    "shutdown",
}
REQUEST_ID_TYPES = {"execute", "interrupt", "inspect-variables"}


# A single expression keeps inspection out of the user's history and namespace.
# It summarizes only exact built-in values plus well-known array/table shapes;
# it never calls an arbitrary object's repr or walks its attributes.
VARIABLE_INSPECTION_EXPRESSION = r"""
(
    lambda _b, _g, _j, _s, _function_type, _builtin_function_type: (
        lambda _known_scientific_types: (
            lambda _names: _j.dumps(
                {
                    "variables": [
                        (
                            lambda _v, _t: {
                                "name": _n,
                                "typeName": _b.type.__getattribute__(_t, "__name__")[:256],
                                "shape": (
                                    _b.str(_b.tuple(_v.shape))[:4096]
                                    if _t in _known_scientific_types
                                    and _b.len(_v.shape) <= 8
                                    else None
                                ),
                                "size": (
                                    _b.len(_v)
                                    if _t
                                    in {
                                        _b.str,
                                        _b.bytes,
                                        _b.bytearray,
                                        _b.list,
                                        _b.tuple,
                                        _b.dict,
                                        _b.set,
                                        _b.frozenset,
                                        _b.range,
                                    }
                                    else (
                                        _b.int(_v.size)
                                        if _t in _known_scientific_types
                                        else None
                                    )
                                ),
                                "preview": (
                                    (_b.repr(_v[:160]) + ("..." if _b.len(_v) > 160 else ""))[
                                        :4096
                                    ]
                                    if _t in {_b.str, _b.bytes, _b.bytearray}
                                    else (
                                        _b.repr(_v)[:4096]
                                        if _t
                                        in {
                                            _b.int,
                                            _b.float,
                                            _b.complex,
                                            _b.bool,
                                            _b.type(None),
                                            _b.range,
                                        }
                                        else None
                                    )
                                ),
                            }
                        )(_g[_n], _b.type(_g[_n]))
                        for _n in _names[:200]
                    ],
                    "truncated": _b.len(_names) > 200,
                },
                separators=(",", ":"),
            )
        )(
            _b.sorted(
                _n
                for _n, _v in _g.items()
                if not _n.startswith("_")
                and _n not in {"In", "Out", "exit", "get_ipython", "open", "quit"}
                and _b.len(_n) <= 256
                and _b.type(_v)
                not in {_b.type(_s), _function_type, _builtin_function_type}
                and not _b.isinstance(_v, _b.type)
            )
        )
    )(
        {
            _candidate
            for _module_name, _type_name in {
                ("numpy", "ndarray"),
                ("pandas.core.frame", "DataFrame"),
                ("pandas.core.series", "Series"),
            }
            for _module in [_s.modules.get(_module_name)]
            if _b.type(_module) is _b.type(_s)
            for _candidate in [_b.vars(_module).get(_type_name)]
            if _b.isinstance(_candidate, _b.type)
        }
    )
)(
    __import__("builtins"),
    globals(),
    __import__("json"),
    __import__("sys"),
    __import__("builtins").type(lambda: None),
    __import__("builtins").type(__import__("builtins").len),
)
""".strip()

UNSUPPORTED_IOPUB_TYPES = {"update_display_data", "clear_output"}

class ProtocolViolation(Exception):
    """An inbound message violated the stateful bridge protocol."""


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


def _read_exact(n: int, stream: BinaryIO) -> bytes:
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            raise EOFError("Stream ended before requested bytes were read.")
        data += chunk
    return data


def read_frame(stream: BinaryIO) -> dict[str, Any]:
    """Read and decode one framed JSON object."""
    header = _read_exact(FRAME_HEADER.size, stream)
    (length,) = FRAME_HEADER.unpack(header)
    if length > MAX_FRAME:
        raise ValueError(f"Frame length {length} exceeds limit {MAX_FRAME}.")
    payload = _read_exact(length, stream)
    message = json.loads(payload.decode("utf-8"))
    if not isinstance(message, dict):
        raise ValueError("Protocol payload must be a JSON object.")
    return message


def encode_frame(message: dict[str, Any], limit: int = MAX_FRAME) -> bytes:
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    if len(payload) > limit:
        raise ValueError(f"Encoded payload {len(payload)} exceeds limit {limit}.")
    return FRAME_HEADER.pack(len(payload)) + payload


def truncate_utf8(value: Any, maximum_bytes: int) -> tuple[str, bool]:
    text = value if isinstance(value, str) else str(value)
    encoded = text.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return text, False
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore"), True


def detach_protocol_stream() -> BinaryIO:
    """Move the protocol off file descriptor 1 and hand back the real pipe.

    After this returns, the only object in the process that can reach the
    transport is the returned stream: fd 1 points at ``/dev/null``, so a stray
    ``print``, a C extension writing to ``stdout``, or a child that inherits fd 1
    can no longer corrupt a frame.  ``os.dup`` produces a non-inheritable
    descriptor, so the duplicate does not leak into the kernel either.

    The stream is buffered on purpose: ``BufferedWriter.flush`` keeps writing
    until a partial pipe write completes, while a raw ``FileIO.write`` can return
    short and leave half a frame on the wire.
    """
    sys.stdout.flush()
    outbound_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull_fd, 1)
    finally:
        os.close(devnull_fd)
    return os.fdopen(outbound_fd, "wb")


# ---------------------------------------------------------------------------
# Outbound queue
# ---------------------------------------------------------------------------


class OutboundQueue:
    """Frames waiting to be written, with a high-water mark and no hard cap.

    Refusing a frame is not a real option: the frame describes something the
    user's code already did, and there is nowhere to put it back.  So the queue
    accepts everything and reports pressure instead, and the producer is expected
    to flush once ``pressured`` is true.  Memory stays bounded by that contract
    rather than by dropping output.
    """

    def __init__(
        self,
        high_water_frames: int = OUTBOUND_HIGH_WATER_FRAMES,
        high_water_bytes: int = OUTBOUND_HIGH_WATER_BYTES,
    ) -> None:
        self._queue: list[bytes] = []
        self._bytes = 0
        self._high_water_frames = high_water_frames
        self._high_water_bytes = high_water_bytes
        self._closed = False

    def put(self, frame: bytes) -> None:
        if self._closed:
            raise RuntimeError("Queue is closed.")
        self._queue.append(frame)
        self._bytes += len(frame)

    def pressured(self) -> bool:
        return (
            len(self._queue) >= self._high_water_frames
            or self._bytes >= self._high_water_bytes
        )

    def pending_bytes(self) -> int:
        return self._bytes

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
    """Tracks the one execution Jupyter permits this bridge to run."""

    def __init__(self) -> None:
        self.active_request_id: Optional[str] = None
        self.active_msg_id: Optional[str] = None
        self.shell_reply: Optional[dict[str, Any]] = None
        self.iopub_busy = False
        self.iopub_idle = False
        self.interrupt_requested = False
        self.warned_message_types: set[str] = set()

    def is_complete(self) -> bool:
        """Whether both channels have said everything they are going to say.

        ``iopub_busy`` is deliberately not required.  The busy status and the
        shell reply travel on independent channels, so a busy that is missed --
        or that a fast cell never publishes before going idle -- would otherwise
        leave the execution hanging forever.  Busy is still tracked, because the
        interrupt path needs to know the code actually started.
        """
        return self.shell_reply is not None and self.iopub_idle

    def outcome(self) -> str:
        """What the kernel's own reply says happened.

        The shell reply is the only honest source.  An interrupt that arrives
        after the code already finished must not turn a successful run into a
        cancellation, and a ``KeyboardInterrupt`` the user asked for must not be
        reported as the kind of failure an ordinary exception is.
        """
        reply = self.shell_reply
        if reply is None:
            # No reply at all: the kernel was interrupted hard enough to skip it,
            # or it died.  Only the first of those is a cancellation.
            return "cancelled" if self.interrupt_requested else "failed"
        status = reply.get("status")
        if status == "ok":
            return "succeeded"
        if status == "abort":
            return "cancelled"
        if self.interrupt_requested and reply.get("ename") == "KeyboardInterrupt":
            return "cancelled"
        return "failed"

    def reset(self) -> None:
        self.active_request_id = None
        self.active_msg_id = None
        self.shell_reply = None
        self.iopub_busy = False
        self.iopub_idle = False
        self.interrupt_requested = False
        self.warned_message_types = set()


# ---------------------------------------------------------------------------
# Inbound reader
# ---------------------------------------------------------------------------


class InboundReader:
    """Reads framed commands on a daemon thread and hands them to the loop.

    A blocking read on a pipe cannot be cancelled, which rules out both places
    it would otherwise live.  It cannot be a task, because the loop could never
    abandon it; and it cannot be ``asyncio.to_thread``, because the default
    executor's threads are joined at interpreter exit, so a thread parked in
    ``read`` would hang the process forever.  A daemon thread can simply be left
    parked, and the lockstep handoff below keeps it from reading ahead while the
    loop is still busy with the previous command.
    """

    def __init__(self, stream: BinaryIO, loop: asyncio.AbstractEventLoop) -> None:
        self._stream = stream
        self._loop = loop
        self._queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=1)
        self._taken = threading.Event()
        self._thread = threading.Thread(
            target=self._pump, name="scient-bridge-stdin", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def _deliver(self, item: tuple[str, Any]) -> None:
        # ``maxsize=1`` plus the handshake in ``_pump`` means this cannot raise
        # ``QueueFull``: the thread does not read again until the loop has taken
        # the previous item.
        self._queue.put_nowait(item)

    def _pump(self) -> None:
        while True:
            try:
                item: tuple[str, Any] = ("frame", read_frame(self._stream))
            except EOFError:
                item = ("eof", None)
            except Exception as error:  # noqa: BLE001 - reported, not raised
                item = ("error", error)
            self._taken.clear()
            try:
                self._loop.call_soon_threadsafe(self._deliver, item)
            except RuntimeError:
                # The loop closed while we were blocked; there is nobody to tell.
                return
            self._taken.wait()
            if item[0] != "frame":
                return

    async def next(self) -> tuple[str, Any]:
        item = await self._queue.get()
        self._taken.set()
        return item


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------


class ScientBridge:
    """Owns one kernel and translates between Scient and Jupyter."""

    def __init__(
        self,
        stdin_stream: BinaryIO,
        stdout_stream: BinaryIO,
        stderr_stream: Optional[TextIO] = None,
    ) -> None:
        self._stdin = stdin_stream
        self._stdout = stdout_stream
        self._stderr = stderr_stream or sys.stderr
        self._outbound = OutboundQueue()
        self._mapping = ExecuteMapping()
        self._session_id: Optional[str] = None
        self._generation = 1
        self._owner_token: Optional[str] = None
        self._peer_frame_limit = MAX_FRAME
        self._server_sequence = 0
        self._bridge_sequence = 0
        self._kernel_manager: Any = None
        self._kernel_client: Any = None
        self._kernel_pid: Optional[int] = None
        self._execution_task: Optional[asyncio.Task[None]] = None
        self._kernel_monitor_task: Optional[asyncio.Task[None]] = None
        self._recent_msg_ids: dict[str, str] = {}
        self._kernel_transitioning = False
        self._running = True
        self._handshake_complete = False
        self._capabilities = ["execute", "interrupt", "restart", "shutdown", "variables"]
        self._stop = asyncio.Event()
        self._write_lock = asyncio.Lock()

    # -- outbound -----------------------------------------------------------

    def _send(
        self,
        msg_type: str,
        payload: dict[str, Any],
        request_id: Optional[str] = None,
    ) -> None:
        """Queue one frame.

        Synchronous on purpose: minting the sequence, encoding and queueing
        happen with no ``await`` between them, so two concurrent senders on this
        single-threaded loop cannot interleave into duplicated or out-of-order
        sequence numbers, and no lock is needed to say so.  The sequence is
        advanced only after the frame is queued, so an encode that fails does not
        leave a hole the transport would read as a lost message.
        """
        if self._session_id is None:
            raise ProtocolViolation("Cannot send a message before session identity is known.")
        frame = encode_frame(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": msg_type,
                "sessionId": self._session_id,
                "generation": self._generation,
                "requestId": request_id,
                "sequence": self._bridge_sequence,
                "payload": payload,
            },
            self._peer_frame_limit,
        )
        self._outbound.put(frame)
        self._bridge_sequence += 1

    def _send_warning(
        self,
        code: str,
        detail: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> None:
        bounded = None if detail is None else truncate_utf8(detail, MAX_DETAIL)[0]
        self._send("warning", {"code": code, "detail": bounded}, request_id)

    def _send_fatal(self, reason: str) -> None:
        """Report an unrecoverable condition, best effort.

        A fatal is the last thing the transport will hear, so it must not itself
        raise: if the frame cannot even be queued, the reason still belongs in
        the diagnostic stream where a launch failure would be read.
        """
        bounded, _ = truncate_utf8(reason, MAX_DETAIL)
        if self._session_id is None:
            self._diag(f"Fatal before session identity was known: {bounded}")
            return
        try:
            self._send("fatal", {"reason": bounded})
        except Exception as error:  # noqa: BLE001 - diagnostics are the fallback
            self._diag(f"Could not report fatal '{bounded}': {error}")

    async def _flush(self) -> None:
        async with self._write_lock:
            frames = self._outbound.drain()
            if not frames:
                return
            # One joined write per flush: the frames are already length-prefixed,
            # so concatenating them preserves order at one syscall instead of N.
            # The write runs off-loop because it blocks while the transport is
            # behind, which is exactly the back-pressure this queue wants.
            try:
                await asyncio.to_thread(self._write_frames, b"".join(frames))
            except OSError as error:
                # The transport is gone.  There is nobody left to tell, so stop.
                self._diag(f"Outbound write failed: {error}")
                self._request_stop()

    def _write_frames(self, data: bytes) -> None:
        self._stdout.write(data)
        self._stdout.flush()

    def _diag(self, message: str) -> None:
        bounded, _ = truncate_utf8(message, MAX_DIAGNOSTIC)
        with contextlib.suppress(Exception):
            self._stderr.write(bounded + "\n")
            self._stderr.flush()

    def _request_stop(self) -> None:
        """Ask the run loop to finish.

        ``_running`` is the loop's predicate and ``_stop`` is what wakes it out
        of the read it is parked on; a caller should never have to remember to
        set both.
        """
        self._running = False
        if not self._stop.is_set():
            self._stop.set()

    # -- inbound validation -------------------------------------------------

    def _validate_message(self, message: dict[str, Any]) -> None:
        if message.get("protocolVersion") != PROTOCOL_VERSION:
            raise ProtocolViolation("Unsupported protocol version.")
        msg_type = message.get("type")
        if msg_type not in SERVER_MESSAGE_TYPES:
            raise ProtocolViolation(f"Unknown command type: {msg_type}")
        if message.get("sequence") != self._server_sequence:
            raise ProtocolViolation(
                f"Expected server sequence {self._server_sequence}, "
                f"received {message.get('sequence')}."
            )
        self._server_sequence += 1

        request_id = message.get("requestId")
        if msg_type in REQUEST_ID_TYPES:
            if not isinstance(request_id, str) or not request_id:
                raise ProtocolViolation(f"{msg_type} requires a requestId.")
        elif request_id is not None:
            raise ProtocolViolation(f"{msg_type} must not carry a requestId.")

        session_id = message.get("sessionId")
        generation = message.get("generation")
        if not isinstance(session_id, str) or not session_id:
            raise ProtocolViolation("sessionId must be a non-empty string.")
        if not isinstance(generation, int) or generation < 1:
            raise ProtocolViolation("generation must be a positive integer.")

        if msg_type == "hello":
            if self._handshake_complete:
                raise ProtocolViolation("hello was already received.")
            return
        if not self._handshake_complete or self._session_id is None:
            raise ProtocolViolation("hello must be the first command.")
        if session_id != self._session_id:
            raise ProtocolViolation("Session identity changed after handshake.")
        if generation != self._generation:
            raise ProtocolViolation(
                f"Expected generation {self._generation}, received {generation}."
            )

        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise ProtocolViolation("payload must be an object.")
        if msg_type == "restart":
            next_generation = payload.get("nextGeneration")
            if next_generation != self._generation + 1:
                raise ProtocolViolation(
                    f"Restart must advance generation to {self._generation + 1}."
                )

    def _handle_hello(self, message: dict[str, Any]) -> None:
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise ProtocolViolation("hello payload must be an object.")
        owner_token = payload.get("ownerToken")
        frame_limit = payload.get("frameLimit")
        required = payload.get("requiredCapabilities")
        if not isinstance(owner_token, str) or not owner_token:
            raise ProtocolViolation("hello ownerToken must be a non-empty string.")
        if not isinstance(frame_limit, int) or frame_limit <= 0:
            raise ProtocolViolation("hello frameLimit must be positive.")
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            raise ProtocolViolation("hello requiredCapabilities must be a string array.")

        self._session_id = message["sessionId"]
        self._generation = message["generation"]
        self._owner_token = owner_token
        self._peer_frame_limit = min(frame_limit, MAX_FRAME)
        self._handshake_complete = True

        missing = set(required) - set(self._capabilities)
        if missing:
            self._send_fatal(f"Missing capabilities: {','.join(sorted(missing))}")
            self._request_stop()
            return
        self._send(
            "hello-ack",
            {
                "ownerToken": owner_token,
                "pid": os.getpid(),
                "platform": sys.platform,
                "capabilities": self._capabilities,
            },
        )

    def _ensure_kernel_monitor(self) -> None:
        if self._kernel_monitor_task is None or self._kernel_monitor_task.done():
            self._kernel_monitor_task = asyncio.create_task(self._monitor_kernel())

    async def _monitor_kernel(self) -> None:
        """Drain idle/late IOPub and detect a kernel that dies between cells."""
        last_liveness = time.monotonic()
        try:
            while self._running and not self._stop.is_set():
                if self._mapping.active_request_id is None and not self._kernel_transitioning:
                    if await self._drain_idle_iopub():
                        await self._flush()
                    now = time.monotonic()
                    if now - last_liveness >= LIVENESS_INTERVAL:
                        last_liveness = now
                        if not await self._kernel_alive():
                            await self._fail_fatal("The kernel process exited while idle.")
                            return
                await asyncio.sleep(IDLE_POLL_INTERVAL)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - reported as session loss
            await self._fail_fatal(f"Kernel communication failed while idle: {error}")

    async def _drain_idle_iopub(self) -> bool:
        if self._kernel_client is None:
            return False
        drained = 0
        pending_stream: Optional[tuple[Optional[str], str, str]] = None

        async def flush_stream() -> None:
            nonlocal pending_stream
            if pending_stream is None:
                return
            request_id, name, text = pending_stream
            pending_stream = None
            self._map_stream({"name": name, "text": text}, request_id)
            if self._outbound.pressured():
                await self._flush()

        while drained < MAX_IOPUB_BATCH:
            try:
                message = await self._kernel_client.get_iopub_msg(timeout=0)
            except queue.Empty:
                break
            drained += 1
            parent_id = message.get("parent_header", {}).get("msg_id")
            request_id = None if parent_id is None else self._recent_msg_ids.get(parent_id)
            if parent_id is None or request_id is not None:
                msg_type = message.get("msg_type")
                content = message.get("content", {})
                if msg_type == "stream" and isinstance(content, dict):
                    name = content.get("name", "stdout")
                    if name not in {"stdout", "stderr"}:
                        name = "stdout"
                    text = content.get("text", "")
                    if not isinstance(text, str):
                        text = str(text)
                    if pending_stream is not None:
                        prior_request, prior_name, prior_text = pending_stream
                        combined = prior_text + text
                        if (
                            prior_request == request_id
                            and prior_name == name
                            and len(combined.encode("utf-8")) <= MAX_STREAM_TEXT
                        ):
                            pending_stream = (request_id, name, combined)
                            continue
                        await flush_stream()
                    pending_stream = (request_id, name, text)
                else:
                    await flush_stream()
                    self._handle_iopub(msg_type, content, request_id)
                    if self._outbound.pressured():
                        await self._flush()
        await flush_stream()
        return drained > 0

    # -- kernel lifecycle ---------------------------------------------------

    @staticmethod
    def _make_kernel_manager(kernel_name: Optional[str]) -> Any:
        """Build the manager for this session's kernel.

        ``None`` means Python, and launches ``ipykernel`` inside this very
        interpreter: the server already chose the interpreter when it spawned the
        bridge, so no kernelspec installed elsewhere on the machine can redirect
        which Python runs the user's code.  A name selects an installed
        kernelspec instead, which is how another language reuses this transport
        without the bridge having to know the language.
        """
        from jupyter_client import AsyncKernelManager

        if kernel_name is not None:
            return AsyncKernelManager(kernel_name=kernel_name)

        from jupyter_client.kernelspec import KernelSpec, KernelSpecManager

        class SelectedInterpreterKernelSpecManager(KernelSpecManager):
            def __init__(self, spec: Any) -> None:
                super().__init__()
                self._spec = spec

            def get_kernel_spec(self, _kernel_name: str) -> Any:
                return self._spec

        spec = KernelSpec(
            argv=[
                sys.executable,
                "-m",
                "ipykernel_launcher",
                "-f",
                "{connection_file}",
            ],
            display_name="Scient Python",
            language="python",
        )
        return AsyncKernelManager(
            kernel_name="scient-python",
            kernel_spec_manager=SelectedInterpreterKernelSpecManager(spec),
        )

    def _read_kernel_pid(self) -> int:
        pid = getattr(getattr(self._kernel_manager, "provisioner", None), "pid", None)
        if not isinstance(pid, int) or pid <= 0:
            raise RuntimeError("The kernel provisioner did not report a valid PID.")
        return pid

    async def _kernel_alive(self) -> bool:
        manager = self._kernel_manager
        if manager is None:
            return False
        try:
            return bool(await manager.is_alive())
        except Exception:  # noqa: BLE001 - an unanswerable kernel is a dead one
            return False

    async def _kernel_info(self) -> dict[str, Any]:
        msg_id = self._kernel_client.kernel_info()
        deadline = time.monotonic() + STARTUP_TIMEOUT
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("The kernel did not answer kernel_info in time.")
            try:
                message = await self._kernel_client.get_shell_msg(timeout=remaining)
            except queue.Empty as error:
                raise RuntimeError("The kernel did not answer kernel_info in time.") from error
            if message.get("parent_header", {}).get("msg_id") == msg_id:
                content = message.get("content", {})
                return content if isinstance(content, dict) else {}

    async def _start_kernel(self, payload: dict[str, Any]) -> None:
        if self._kernel_manager is not None:
            raise ProtocolViolation("A kernel is already running.")
        working_directory = payload.get("workingDirectory") or os.getcwd()
        if not isinstance(working_directory, str):
            raise ProtocolViolation("start-kernel workingDirectory must be a string.")
        kernel_name = payload.get("kernelName")
        if kernel_name is not None and (not isinstance(kernel_name, str) or not kernel_name):
            raise ProtocolViolation("start-kernel kernelName must be a non-empty string or null.")

        self._kernel_manager = self._make_kernel_manager(kernel_name)
        # ``stdout=DEVNULL`` is the other half of keeping the protocol intact.
        # ``detach_protocol_stream`` already moved the real pipe out of reach, so
        # this only stops the kernel from inheriting whatever now sits on fd 1 --
        # but a kernel writing into /dev/null is still a kernel whose output we
        # cannot see, and stdout is not where Jupyter puts anything we need.
        # stderr is left inherited on purpose: a kernel that fails to start
        # explains itself there, and that is what reaches the launch diagnostics.
        # ``jupyter_client`` replays these arguments on restart, so the
        # redirection survives every generation of this session.
        kernel_environment = os.environ.copy()
        # A scientific session is a rich-output surface, so Matplotlib should
        # publish figures through Jupyter rather than opening a window or using
        # a headless backend that silently discards ``show()``.  ipykernel
        # already depends on matplotlib-inline; importing Matplotlib remains
        # lazy and user code can still choose another backend explicitly.
        kernel_environment["MPLBACKEND"] = "module://matplotlib_inline.backend_inline"
        await self._kernel_manager.start_kernel(
            cwd=working_directory,
            env=kernel_environment,
            stdout=subprocess.DEVNULL,
        )
        self._kernel_pid = self._read_kernel_pid()
        self._kernel_client = self._kernel_manager.client()
        self._kernel_client.start_channels()
        await self._kernel_client.wait_for_ready(timeout=STARTUP_TIMEOUT)
        info = await self._kernel_info()
        language = info.get("language_info", {})
        if not isinstance(language, dict):
            language = {}
        self._send(
            "kernel-ready",
            {
                "kernelPid": self._kernel_pid,
                "languageId": language.get("name", "python"),
                "languageVersion": language.get("version", "unknown"),
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": self._capabilities,
            },
        )
        self._ensure_kernel_monitor()

    async def _cancel_execution_task(
        self,
        emit_completion: bool,
        outcome: str = "cancelled",
    ) -> Optional[str]:
        """Abandon the in-flight execution, optionally telling the server why.

        The outcome is a parameter rather than a constant because the reason
        differs: a restart or shutdown really did cancel the work, while a kernel
        that died underneath it has no outcome to report at all -- that is loss,
        and loss is reported about the session.
        """
        request_id = self._mapping.active_request_id
        task = self._execution_task
        self._execution_task = None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._mapping.reset()
        if emit_completion and request_id is not None:
            self._send("execution-complete", {"outcome": outcome}, request_id)
        return request_id

    async def _restart_kernel(self, next_generation: int) -> None:
        if self._kernel_manager is None:
            raise ProtocolViolation("No kernel is running.")
        self._kernel_transitioning = True
        try:
            cancelled_request_id = await self._cancel_execution_task(emit_completion=False)
            self._recent_msg_ids.clear()
            if self._kernel_client is not None:
                with contextlib.suppress(Exception):
                    self._kernel_client.stop_channels()
            await self._kernel_manager.restart_kernel(now=True)
            self._kernel_pid = self._read_kernel_pid()
            self._kernel_client = self._kernel_manager.client()
            self._kernel_client.start_channels()
            await self._kernel_client.wait_for_ready(timeout=STARTUP_TIMEOUT)
        finally:
            self._kernel_transitioning = False
        # Cancellation is a fact only after replacement succeeded.  If restart
        # fails, the session is lost and neither a cancellation nor a new
        # generation is claimed.
        if cancelled_request_id is not None:
            self._send(
                "execution-complete",
                {"outcome": "cancelled"},
                cancelled_request_id,
            )
        # Advanced before the frame is built so the envelope already carries the
        # new generation; the payload does not repeat it.
        self._generation = next_generation
        self._send("restarted", {"kernelPid": self._kernel_pid})

    async def _stop_kernel_process(self) -> None:
        manager = self._kernel_manager
        if manager is None or not manager.has_kernel:
            return
        try:
            await asyncio.wait_for(manager.shutdown_kernel(now=False), timeout=SHUTDOWN_TIMEOUT)
            if not manager.has_kernel or not await self._kernel_alive():
                return
            self._diag("Graceful kernel shutdown returned while the kernel was still alive.")
        except Exception as error:  # noqa: BLE001 - escalation is the handler
            self._diag(f"Graceful kernel shutdown failed: {error}")
        try:
            await asyncio.wait_for(manager.shutdown_kernel(now=True), timeout=SHUTDOWN_TIMEOUT)
        except Exception as error:  # noqa: BLE001 - the transport kills the tree
            self._diag(f"Forced kernel shutdown failed: {error}")
            raise RuntimeError("The kernel did not stop after forced shutdown.") from error
        if manager.has_kernel and await self._kernel_alive():
            raise RuntimeError("The kernel remained alive after forced shutdown.")

    async def _shutdown_kernel(self) -> None:
        self._kernel_transitioning = True
        cancelled_request_id = await self._cancel_execution_task(emit_completion=False)
        if self._kernel_client is not None:
            with contextlib.suppress(Exception):
                self._kernel_client.stop_channels()
        await self._stop_kernel_process()
        if cancelled_request_id is not None:
            self._send(
                "execution-complete",
                {"outcome": "cancelled"},
                cancelled_request_id,
            )
        self._send("shutdown-complete", {})

    async def _fail_fatal(self, reason: str) -> None:
        """Report the session as lost and wind the bridge down.

        No ``execution-complete`` is emitted.  An execution whose kernel vanished
        has no outcome the bridge can honestly claim, and the contract reports
        loss about the session rather than about the work it was doing.
        """
        self._mapping.reset()
        self._execution_task = None
        self._send_fatal(reason)
        with contextlib.suppress(Exception):
            await self._flush()
        self._request_stop()

    # -- execution ----------------------------------------------------------

    async def _handle_execute(self, payload: dict[str, Any], request_id: str) -> None:
        if self._kernel_client is None:
            raise ProtocolViolation("No kernel is running.")
        if self._mapping.active_request_id is not None:
            raise ProtocolViolation("An execution is already active.")
        code = payload.get("code")
        if not isinstance(code, str):
            raise ProtocolViolation("execute code must be a string.")
        if len(code.encode("utf-8")) > MAX_CODE:
            raise ProtocolViolation(f"execute code exceeds {MAX_CODE} bytes.")

        # Submitted before it is recorded as active: a submit that raises must
        # leave the session able to run the next cell, not holding its only
        # execution slot for work that never started.
        msg_id = self._kernel_client.execute(
            code,
            silent=bool(payload.get("silent", False)),
            store_history=bool(payload.get("storeHistory", True)),
            allow_stdin=False,
        )
        self._mapping.active_request_id = request_id
        self._mapping.active_msg_id = msg_id
        self._recent_msg_ids[msg_id] = request_id
        while len(self._recent_msg_ids) > 64:
            del self._recent_msg_ids[next(iter(self._recent_msg_ids))]
        self._send("accepted", {}, request_id)
        await self._flush()
        self._execution_task = asyncio.create_task(self._correlate(request_id, msg_id))

    async def _handle_inspect_variables(self, request_id: str) -> None:
        """Return a bounded live namespace summary without entering history."""
        if self._kernel_client is None:
            raise ProtocolViolation("No kernel is running.")
        if self._kernel_transitioning:
            raise ProtocolViolation("The kernel is changing generation.")
        if self._mapping.active_request_id is not None:
            raise ProtocolViolation("An execution is already active.")

        try:
            msg_id = self._kernel_client.execute(
                "",
                silent=True,
                store_history=False,
                user_expressions={"scient_variables": VARIABLE_INSPECTION_EXPRESSION},
                allow_stdin=False,
            )
            deadline = time.monotonic() + INSPECTION_TIMEOUT
            reply: Optional[dict[str, Any]] = None
            while time.monotonic() < deadline:
                try:
                    message = await self._kernel_client.get_shell_msg(timeout=0)
                except queue.Empty:
                    if not await self._kernel_alive():
                        raise RuntimeError("The kernel process exited during variable inspection.")
                    await asyncio.sleep(IDLE_POLL_INTERVAL)
                    continue
                if message.get("parent_header", {}).get("msg_id") != msg_id:
                    continue
                content = message.get("content", {})
                reply = content if isinstance(content, dict) else {}
                break

            if reply is None:
                raise TimeoutError("Variable inspection timed out.")
            if reply.get("status") != "ok":
                raise RuntimeError("The kernel could not inspect its current variables.")
            expression = reply.get("user_expressions", {}).get("scient_variables", {})
            if expression.get("status") != "ok":
                raise RuntimeError("The runtime could not summarize its current variables.")
            plain = expression.get("data", {}).get("text/plain")
            if not isinstance(plain, str):
                raise RuntimeError("The runtime returned an unreadable variable summary.")
            encoded = ast.literal_eval(plain)
            if not isinstance(encoded, str):
                raise RuntimeError("The runtime returned an invalid variable summary.")
            decoded = json.loads(encoded)
            variables = decoded.get("variables") if isinstance(decoded, dict) else None
            if not isinstance(variables, list):
                raise RuntimeError("The runtime returned an invalid variable list.")

            normalized: list[dict[str, Any]] = []
            for candidate in variables[:MAX_VARIABLES]:
                if not isinstance(candidate, dict):
                    continue
                name = candidate.get("name")
                type_name = candidate.get("typeName")
                if not isinstance(name, str) or not name or len(name) > MAX_VARIABLE_NAME:
                    continue
                if not isinstance(type_name, str) or not type_name:
                    continue
                shape = candidate.get("shape")
                size = candidate.get("size")
                preview = candidate.get("preview")
                normalized.append(
                    {
                        "name": name,
                        "typeName": type_name[:MAX_VARIABLE_TYPE],
                        "shape": shape[:MAX_VARIABLE_TEXT] if isinstance(shape, str) else None,
                        "size": size
                        if isinstance(size, int) and 0 <= size <= MAX_SAFE_JSON_INTEGER
                        else None,
                        "preview": preview[:MAX_VARIABLE_TEXT]
                        if isinstance(preview, str)
                        else None,
                    }
                )
            self._send(
                "variables",
                {
                    "variables": normalized,
                    "truncated": bool(decoded.get("truncated"))
                    or len(variables) > MAX_VARIABLES,
                    "error": None,
                },
                request_id,
            )
        except Exception as error:  # noqa: BLE001 - inspection is optional, not fatal
            detail, _ = truncate_utf8(str(error), MAX_DETAIL)
            self._send(
                "variables",
                {"variables": [], "truncated": False, "error": detail},
                request_id,
            )

    async def _correlate(self, request_id: str, msg_id: str) -> None:
        """Pump both kernel channels until the execution is complete.

        Both channels are polled without blocking and the loop only sleeps when
        neither produced anything, so a chatty cell is drained at memory speed
        instead of paying a fixed poll timeout per message.

        Liveness is checked on the idle path rather than against a deadline: a
        cell may legitimately run for hours, so there is no honest timeout, but a
        kernel that has exited will never send the reply this loop waits for.
        """
        last_liveness = time.monotonic()
        try:
            while not self._mapping.is_complete():
                progressed = await self._drain_iopub(request_id, msg_id)
                if self._mapping.shell_reply is None and await self._poll_shell(msg_id):
                    progressed = True
                if progressed:
                    await self._flush()
                    continue
                now = time.monotonic()
                if now - last_liveness >= LIVENESS_INTERVAL:
                    last_liveness = now
                    if not await self._kernel_alive():
                        await self._fail_fatal("The kernel process exited while running code.")
                        return
                await asyncio.sleep(IDLE_POLL_INTERVAL)

            self._send("execution-complete", {"outcome": self._mapping.outcome()}, request_id)
            self._mapping.reset()
            self._execution_task = None
            await self._flush()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - reported as session loss
            await self._fail_fatal(f"Kernel communication failed: {error}")

    async def _drain_iopub(self, request_id: str, msg_id: str) -> bool:
        drained = 0
        pending_stream: Optional[tuple[str, str]] = None

        async def flush_stream() -> None:
            nonlocal pending_stream
            if pending_stream is None:
                return
            name, text = pending_stream
            pending_stream = None
            self._map_stream({"name": name, "text": text}, request_id)
            if self._outbound.pressured():
                await self._flush()

        while drained < MAX_IOPUB_BATCH:
            try:
                message = await self._kernel_client.get_iopub_msg(timeout=0)
            except queue.Empty:
                break
            drained += 1
            parent_id = message.get("parent_header", {}).get("msg_id")
            if parent_id == msg_id:
                msg_type = message.get("msg_type")
                content = message.get("content", {})
                if msg_type == "stream" and isinstance(content, dict):
                    name = content.get("name", "stdout")
                    if name not in {"stdout", "stderr"}:
                        name = "stdout"
                    text = content.get("text", "")
                    if not isinstance(text, str):
                        text = str(text)
                    if pending_stream is not None:
                        prior_name, prior_text = pending_stream
                        combined = prior_text + text
                        if prior_name == name and len(combined.encode("utf-8")) <= MAX_STREAM_TEXT:
                            pending_stream = (name, combined)
                            continue
                        await flush_stream()
                    pending_stream = (name, text)
                else:
                    await flush_stream()
                    self._handle_iopub(msg_type, content, request_id)
            elif parent_id is None:
                await flush_stream()
                # A kernel-level message that no execution caused.  Worth
                # reporting, but not against work that did not produce it.
                self._handle_iopub(message.get("msg_type"), message.get("content", {}), None)
            if self._outbound.pressured():
                await self._flush()
        await flush_stream()
        return drained > 0

    async def _poll_shell(self, msg_id: str) -> bool:
        try:
            reply = await self._kernel_client.get_shell_msg(timeout=0)
        except queue.Empty:
            return False
        if reply.get("parent_header", {}).get("msg_id") != msg_id:
            # A reply to something else, a leftover ``kernel_info`` say.  Consumed
            # so it cannot later be mistaken for this execution's reply.
            return True
        content = reply.get("content", {})
        self._mapping.shell_reply = content if isinstance(content, dict) else {}
        return True

    def _handle_iopub(
        self,
        msg_type: Any,
        content: Any,
        request_id: Optional[str],
    ) -> None:
        if not isinstance(content, dict):
            return
        if msg_type == "stream":
            self._map_stream(content, request_id)
        elif msg_type in {"execute_result", "display_data"}:
            self._map_display(content, request_id)
        elif msg_type == "error":
            self._map_error(content, request_id)
        elif msg_type == "status" and request_id == self._mapping.active_request_id:
            status = content.get("execution_state")
            if status == "busy":
                self._mapping.iopub_busy = True
            elif status == "idle":
                self._mapping.iopub_idle = True
        elif msg_type in UNSUPPORTED_IOPUB_TYPES:
            # Rate limited to once per execution: a cell that redraws in a loop
            # would otherwise bury its own real output under identical warnings.
            if msg_type not in self._mapping.warned_message_types:
                self._mapping.warned_message_types.add(msg_type)
                self._send_warning("runtime-warning", f"{msg_type} is not supported.", request_id)

    def _map_stream(self, content: dict[str, Any], request_id: Optional[str]) -> None:
        stream_name = content.get("name", "stdout")
        if stream_name not in {"stdout", "stderr"}:
            stream_name = "stdout"
        text, truncated = truncate_utf8(content.get("text", ""), MAX_STREAM_TEXT)
        self._send("stream", {"stream": stream_name, "text": text}, request_id)
        if truncated:
            self._send_warning("output-truncated", "Stream text exceeded limit.", request_id)

    def _map_display(self, content: dict[str, Any], request_id: Optional[str]) -> None:
        data = content.get("data", {})
        if not isinstance(data, dict):
            return
        png = data.get("image/png")
        if isinstance(png, str):
            # Measured as UTF-8, which is how it is about to be encoded into a
            # frame.  Base64 is ASCII, so for a real image the two readings are
            # the same number; what this closes is a ``_repr_png_`` that returns
            # something else entirely, where an ASCII-only reading would call
            # twenty megabytes of text small and the frame that could not hold it
            # would take the session down with it.
            if len(png.encode("utf-8")) > MAX_PNG_BASE64:
                self._send_warning("output-truncated", "PNG exceeded limit.", request_id)
            else:
                self._send("display", {"mediaType": "image/png", "data": png}, request_id)
            return
        svg = data.get("image/svg+xml")
        if isinstance(svg, str):
            if len(svg.encode("utf-8")) > MAX_SVG_TEXT:
                self._send_warning("output-truncated", "SVG exceeded limit.", request_id)
            else:
                try:
                    self._send(
                        "display", {"mediaType": "image/svg+xml", "data": svg}, request_id
                    )
                except ValueError:
                    # Escaping can make a JSON string larger than its UTF-8
                    # source. Preserve the session and record the dropped
                    # figure instead of letting frame encoding fail execution.
                    self._send_warning("output-truncated", "SVG exceeded frame limit.", request_id)
            return
        plain = data.get("text/plain")
        if isinstance(plain, str):
            text, truncated = truncate_utf8(plain, MAX_STREAM_TEXT)
            self._send("display", {"mediaType": "text/plain", "text": text}, request_id)
            if truncated:
                self._send_warning("output-truncated", "Text display exceeded limit.", request_id)
            return
        # Neither representation the protocol carries. Say what was dropped
        # rather than letting the output vanish: someone who rendered a plot
        # through an SVG-only backend should learn that, not see nothing at all.
        dropped = ", ".join(sorted(str(key) for key in data)[:8])
        self._send_warning(
            "runtime-warning",
            f"Unsupported output media types: {dropped}" if dropped else "Output carried no data.",
            request_id,
        )

    def _map_error(self, content: dict[str, Any], request_id: Optional[str]) -> None:
        name, _ = truncate_utf8(content.get("ename", "UnknownError"), MAX_ERROR_NAME)
        value, _ = truncate_utf8(content.get("evalue", ""), MAX_ERROR_VALUE)
        raw_traceback = content.get("traceback", [])
        traceback: list[str] = []
        if isinstance(raw_traceback, list):
            for line in raw_traceback[:MAX_TRACEBACK_LINES]:
                bounded, _ = truncate_utf8(line, MAX_TRACEBACK_LINE)
                traceback.append(bounded)
        self._send("error", {"name": name, "value": value, "traceback": traceback}, request_id)
        if name == "StdinNotImplementedError":
            # The kernel runs with ``allow_stdin=False``, so a prompt never
            # reaches the bridge as an ``input_request`` to warn about -- it comes
            # back as this error.  Name the cause the user can actually act on.
            self._send_warning(
                "input-unsupported",
                "This session cannot read from standard input.",
                request_id,
            )

    # -- interrupt ----------------------------------------------------------

    async def _handle_interrupt(self, request_id: str) -> None:
        self._send("interrupt-result", {"result": await self._interrupt(request_id)}, request_id)

    async def _interrupt(self, request_id: str) -> str:
        """Deliver an interrupt and say what became of the signal.

        The four answers are distinct on purpose.  ``terminal`` means there was
        nothing left to stop, ``rejected`` means the bridge would not or could
        not signal, ``interrupted`` means the signal landed and the execution
        ended, and ``timeout`` means it landed and the execution did not.  What
        became of the execution itself still arrives as ``execution-complete``;
        this only answers whether the signal was delivered.
        """
        active = self._mapping.active_request_id
        if active is None:
            # The execution ended before the request arrived.  Terminal, not a
            # rejection: the caller got what it wanted, just not because of it.
            return "terminal"
        if active != request_id:
            return "rejected"
        if not await self._await_busy():
            return "terminal"
        if not await self._kernel_alive():
            return "terminal"
        self._mapping.interrupt_requested = True
        try:
            await self._kernel_manager.interrupt_kernel()
        except Exception as error:  # noqa: BLE001 - reported as a rejection
            self._mapping.interrupt_requested = False
            self._diag(f"Interrupt could not be delivered: {error}")
            return "rejected"
        return "interrupted" if await self._await_settled(request_id) else "timeout"

    async def _await_busy(self) -> bool:
        """Wait until the execution is actually running, and say if it survived.

        ``accepted`` means the execute request reached Jupyter, not that the
        kernel started running it.  A signal delivered in that window is lost,
        which would leave an infinite loop running forever, so the interrupt
        waits for the kernel to report itself busy first.
        """
        deadline = time.monotonic() + INTERRUPT_BUSY_TIMEOUT
        while True:
            if self._mapping.active_request_id is None:
                return False
            if self._mapping.iopub_busy:
                return True
            if time.monotonic() >= deadline:
                # Busy never arrived.  Signal anyway: a status message that got
                # missed is far likelier than a kernel that accepted the request
                # and never started it, and refusing would strand the user.
                return True
            await asyncio.sleep(IDLE_POLL_INTERVAL)

    async def _await_settled(self, request_id: str) -> bool:
        deadline = time.monotonic() + INTERRUPT_SETTLE_TIMEOUT
        while self._mapping.active_request_id == request_id:
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(IDLE_POLL_INTERVAL)
        return True

    # -- dispatch and run loop ---------------------------------------------

    async def _dispatch(self, message: dict[str, Any]) -> None:
        self._validate_message(message)
        msg_type = message["type"]
        payload = message.get("payload", {})
        request_id = message.get("requestId")
        if msg_type == "hello":
            self._handle_hello(message)
        elif msg_type == "start-kernel":
            await self._start_kernel(payload)
        elif msg_type == "execute":
            await self._handle_execute(payload, request_id)
        elif msg_type == "interrupt":
            await self._handle_interrupt(request_id)
        elif msg_type == "inspect-variables":
            await self._handle_inspect_variables(request_id)
        elif msg_type == "restart":
            await self._restart_kernel(payload["nextGeneration"])
        elif msg_type == "shutdown":
            await self._shutdown_kernel()
            self._request_stop()
        await self._flush()

    def _install_signal_handlers(self, loop: asyncio.AbstractEventLoop) -> None:
        """Turn a termination signal into an orderly kernel shutdown.

        ``jupyter_client`` starts the kernel in its own session, so a signal sent
        to the bridge's process group never reaches it.  Handling the signal here
        is what lets the bridge ask the kernel to exit, instead of leaving it to
        notice on its own that its parent died.
        """
        for name in ("SIGTERM", "SIGINT", "SIGHUP"):
            handled = getattr(signal, name, None)
            if handled is None:
                continue
            try:
                loop.add_signal_handler(handled, self._request_stop)
            except (NotImplementedError, RuntimeError, ValueError):
                # Windows event loops implement none of these.
                pass

    async def run(self) -> int:
        loop = asyncio.get_running_loop()
        self._install_signal_handlers(loop)
        reader = InboundReader(self._stdin, loop)
        reader.start()
        stopped = asyncio.ensure_future(self._stop.wait())
        try:
            while self._running:
                pending = asyncio.ensure_future(reader.next())
                done, _ = await asyncio.wait(
                    {pending, stopped}, return_when=asyncio.FIRST_COMPLETED
                )
                if pending not in done:
                    # Abandons the await, not the read: the reader thread is a
                    # daemon and may stay parked in ``read`` until exit.
                    pending.cancel()
                    self._diag("Stop requested.")
                    break
                kind, value = pending.result()
                if kind == "eof":
                    self._diag("stdin EOF: parent disconnected.")
                    break
                if kind == "error":
                    self._send_fatal(f"Protocol error: {value}")
                    with contextlib.suppress(Exception):
                        await self._flush()
                    break
                try:
                    await self._dispatch(value)
                except Exception as error:  # noqa: BLE001 - reported, then stop
                    self._send_fatal(f"Protocol error: {error}")
                    with contextlib.suppress(Exception):
                        await self._flush()
                    break
        finally:
            stopped.cancel()
            monitor = self._kernel_monitor_task
            if monitor is not None and monitor is not asyncio.current_task():
                monitor.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await monitor
            with contextlib.suppress(Exception):
                await self._cancel_execution_task(emit_completion=False)
            if self._kernel_client is not None:
                with contextlib.suppress(Exception):
                    self._kernel_client.stop_channels()
            if self._kernel_manager is not None and self._kernel_manager.has_kernel:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        self._kernel_manager.shutdown_kernel(now=True),
                        timeout=SHUTDOWN_TIMEOUT,
                    )
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._flush(), timeout=SHUTDOWN_TIMEOUT)
            self._outbound.close()
        return 0


async def _run(outbound: BinaryIO) -> int:
    return await ScientBridge(sys.stdin.buffer, outbound, sys.stderr).run()


def main() -> int:
    # First statement of the program on purpose: every later line, and every
    # library it imports, must already be unable to reach the protocol stream.
    outbound = detach_protocol_stream()
    return asyncio.run(_run(outbound))


if __name__ == "__main__":
    # Exit without the interpreter's own shutdown.  The inbound reader is a
    # daemon thread parked in a blocking read, so it holds that stream's
    # buffered-reader lock forever; finalization closes ``sys.stdin`` on the way
    # out, waits a second for a lock nobody will ever hand back, and then aborts
    # the whole process (``_enter_buffered_busy``).  The parent would see that
    # abort instead of the exit code below, and every clean shutdown would leave
    # a crash report behind.  ``run`` has already flushed the protocol stream and
    # closed the transport, so there is nothing left here worth crashing over.
    try:
        exit_code = main()
    except BaseException:  # noqa: BLE001 - reported like the interpreter would
        # Printed here rather than left to propagate: the abort above would
        # otherwise replace this failure's exit code with a crash signal.
        sys.excepthook(*sys.exc_info())
        exit_code = 1
    sys.stderr.flush()
    os._exit(exit_code)
