#!/usr/bin/env python3
"""Standard-library tests for the MATLAB Engine protocol adapter."""

import asyncio
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, os.path.dirname(__file__))

import scient_matlab_engine_bridge as matlab_bridge


def decode_frames(data):
    messages = []
    offset = 0
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        offset += 4
        messages.append(json.loads(data[offset : offset + length].decode("utf-8")))
        offset += length
    return messages


class FakeFuture:
    def __init__(self, result, stdout=None, on_result=None):
        self.value = result
        self.stdout = stdout
        self.on_result = on_result
        self.cancelled = False

    def result(self):
        if self.stdout is not None:
            self.stdout.write("MATLAB output\n")
        if self.on_result is not None:
            self.on_result()
        return self.value

    def cancel(self):
        self.cancelled = True
        return True


class FakeEngine:
    def __init__(self, receipt=None, figure=True, tables=None, on_evaluate=None):
        self.receipt = receipt or {"ok": True, "identifier": "", "message": "", "stack": []}
        self.figure = figure
        self.tables = tables or []
        self.on_evaluate = on_evaluate
        self.helper_directory = None
        self.which_override = None
        self.evaluated_paths = []
        self.evaluated_native_files = []
        self.figure_capture_count = 0

    def bind_helpers(self, directory):
        self.helper_directory = directory

    def builtin(self, operation, name, **_kwargs):
        if operation != "which":
            raise AssertionError(f"Unexpected built-in operation: {operation}")
        if self.which_override is not None:
            return self.which_override
        return str(Path(self.helper_directory, f"{name}.m"))

    def __getattr__(self, name):
        if name.startswith("scient_compute_eval_"):
            return self._evaluate
        if name.startswith("scient_compute_figures_"):
            return self._figures
        if name.startswith("scient_compute_tables_"):
            return self._tables
        if name.startswith("scient_compute_variables_"):
            return self._variables
        raise AttributeError(name)

    def _evaluate(self, code_path, native_file=False, *, stdout, **_kwargs):
        self.evaluated_paths.append(code_path)
        self.evaluated_native_files.append(native_file)
        return FakeFuture(json.dumps(self.receipt), stdout, self.on_evaluate)

    def _figures(self, directory, _maximum, **_kwargs):
        if not self.figure:
            return json.dumps({"figures": [], "truncated": False})
        path = Path(directory, "figure-001.png")
        path.write_bytes(matlab_bridge.PNG_SIGNATURE + b"test-pixels")
        native_path = Path(directory, "figure-001.fig")
        self.figure_capture_count += 1
        native_path.write_bytes(f"native-matlab-figure-{self.figure_capture_count}".encode())
        # MATLAB jsonencode represents a one-element struct array as an object.
        return json.dumps(
            {
                "figures": {
                    "key": "1",
                    "path": str(path),
                    "nativePath": str(native_path),
                    "warning": "",
                },
                "truncated": False,
            }
        )

    def _tables(self, _maximum_rows, _maximum_columns, **_kwargs):
        return json.dumps({"tables": self.tables, "truncated": False})

    def _variables(self, _maximum, **_kwargs):
        return json.dumps(
            {
                "variables": {
                    "name": "answer",
                    "typeName": "double",
                    "shape": "1 x 1",
                    "size": 1,
                    "preview": "41",
                },
                "truncated": False,
            }
        )

    def quit(self):
        return None


class FailingQuitEngine(FakeEngine):
    def quit(self):
        raise RuntimeError("still running")


def make_bridge(test_case, engine):
    output = io.BytesIO()
    instance = matlab_bridge.MatlabEngineBridge(
        io.BytesIO(), output, "/matlab/engine", "/matlab"
    )
    instance._session_id = "matlab-test"
    instance._handshake_complete = True
    instance._loop = asyncio.get_running_loop()
    instance._engine = engine
    helper_directory = instance._write_helpers()
    engine.bind_helpers(helper_directory)
    test_case.addCleanup(shutil.rmtree, helper_directory, ignore_errors=True)
    return instance, output


class TestMatlabBridge(unittest.IsolatedAsyncioTestCase):
    async def test_parent_disconnect_and_stop_cancel_pending_startup(self):
        for reason in ("eof", "signal"):
            with self.subTest(reason=reason):
                read_fd, write_fd = os.pipe()
                reader = os.fdopen(read_fd, "rb", buffering=0)
                writer = os.fdopen(write_fd, "wb", buffering=0)
                instance = matlab_bridge.MatlabEngineBridge(
                    reader, io.BytesIO(), "/matlab/engine", "/matlab"
                )
                instance._install_signal_handlers = Mock()
                entered = asyncio.Event()
                cancelled = asyncio.Event()

                async def pending_start(_message):
                    entered.set()
                    try:
                        await asyncio.Future()
                    finally:
                        cancelled.set()

                instance._dispatch = pending_start
                run = asyncio.create_task(instance.run())
                try:
                    payload = json.dumps({"type": "start-kernel"}).encode()
                    writer.write(struct.pack(">I", len(payload)) + payload)
                    await asyncio.wait_for(entered.wait(), timeout=2)
                    if reason == "eof":
                        writer.close()
                    else:
                        instance._request_stop()
                    await asyncio.wait_for(run, timeout=2)
                    self.assertTrue(cancelled.is_set())
                finally:
                    writer.close()
                    reader.close()
                    if not run.done():
                        run.cancel()

    async def test_failed_start_cancels_the_engine_future(self):
        instance = matlab_bridge.MatlabEngineBridge(io.BytesIO(), io.BytesIO(), "/matlab/engine", "/matlab")
        future = Mock()
        future.result.side_effect = TimeoutError("Engine startup timed out")
        module = Mock()
        module.start_matlab.return_value = future
        instance._engine_module = module
        with self.assertRaises(TimeoutError):
            await instance._start_engine("/project")
        module.start_matlab.assert_called_once_with(
            "-nodesktop -nosplash -noFigureWindows", background=True
        )
        future.result.assert_called_once_with(timeout=matlab_bridge.STARTUP_TIMEOUT)
        future.cancel.assert_called_once()
        self.assertIsNone(instance._engine)

    async def test_stream_flood_is_flushed_with_backpressure_before_worker_returns(self):
        instance, output = make_bridge(self, FakeEngine(figure=False))
        text = "אβ output\n" * 100000
        await asyncio.to_thread(instance.forward_stream_from_thread, "stdout", text, "flood")
        messages = decode_frames(output.getvalue())
        self.assertEqual("".join(message["payload"]["text"] for message in messages), text)
        self.assertTrue(all(len(message["payload"]["text"].encode()) <= matlab_bridge.MAX_STREAM_TEXT for message in messages))

    async def test_execution_forwards_text_single_figure_and_completion(self):
        instance, output = make_bridge(self, FakeEngine())
        await instance._handle_execute({"code": "answer = 41"}, "request-1")
        await instance._execution_task
        messages = decode_frames(output.getvalue())
        self.assertIn("accepted", [message["type"] for message in messages])
        self.assertTrue(
            any(
                message["type"] == "stream"
                and "MATLAB output" in message["payload"]["text"]
                for message in messages
            )
        )
        self.assertTrue(any(message["type"] == "display" for message in messages))
        self.assertEqual(messages[-1]["type"], "execution-complete")
        self.assertEqual(messages[-1]["payload"]["outcome"], "succeeded")

    async def test_error_receipt_is_not_transport_loss(self):
        engine = FakeEngine(
            receipt={
                "ok": False,
                "identifier": "Scient:Expected",
                "message": "expected failure",
                "stack": [{"file": "/project/model.m", "line": 7, "name": "model"}],
            },
            figure=False,
        )
        instance, output = make_bridge(self, engine)
        await instance._handle_execute({"code": "error('expected')"}, "request-2")
        await instance._execution_task
        messages = decode_frames(output.getvalue())
        error = next(message for message in messages if message["type"] == "error")
        self.assertEqual(error["payload"]["name"], "Scient:Expected")
        self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_variables_accept_matlabs_single_struct_json_shape(self):
        instance, output = make_bridge(self, FakeEngine(figure=False))
        await instance._handle_variables("variables-1")
        await instance._flush()
        message = decode_frames(output.getvalue())[-1]
        self.assertEqual(message["type"], "variables")
        self.assertEqual(message["payload"]["variables"][0]["name"], "answer")
        self.assertEqual(message["payload"]["variables"][0]["preview"], "41")

    async def test_single_stack_frame_keeps_clickable_source_provenance(self):
        engine = FakeEngine(receipt={"ok": False, "identifier": "Test:Single",
                                    "message": "failure",
                                    "stack": {"file": "/project/test.m", "line": 2, "name": "test"}},
                            figure=False)
        instance, output = make_bridge(self, engine)
        await instance._handle_execute({"code": "error('failure')"}, "single-frame")
        await instance._execution_task
        error = next(message for message in decode_frames(output.getvalue()) if message["type"] == "error")
        self.assertEqual(error["payload"]["traceback"], ["/project/test.m:2:test"])

    async def test_restart_never_starts_a_replacement_after_uncertain_shutdown(self):
        instance, _ = make_bridge(self, FailingQuitEngine(figure=False))
        instance._start_engine = AsyncMock(return_value=("R2026a", "26.1"))

        with self.assertRaisesRegex(RuntimeError, "did not stop cleanly"):
            await instance._restart(2)

        instance._start_engine.assert_not_awaited()
        self.assertEqual(instance._generation, 1)
        self.assertFalse(instance._transitioning)

    async def test_helpers_are_unpredictable_and_resolution_is_identity_bound(self):
        first_engine = FakeEngine(figure=False)
        first, _ = make_bridge(self, first_engine)
        second, _ = make_bridge(self, FakeEngine(figure=False))

        self.assertEqual(set(first._helper_names), {"eval", "figures", "tables", "variables"})
        self.assertTrue(set(first._helper_names.values()).isdisjoint(second._helper_names.values()))
        self.assertFalse(
            {
                "scient_compute_eval.m",
                "scient_compute_figures.m",
                "scient_compute_tables.m",
                "scient_compute_variables.m",
            }
            & {path.name for path in Path(first._helper_directory).iterdir()}
        )
        for kind, name in first._helper_names.items():
            source = Path(first._helper_directory, f"{name}.m").read_text(encoding="utf-8")
            self.assertIn(f"function scientJson = {name}(", source, kind)

        first_engine.which_override = "/project/shadowed_helper.m"
        with self.assertRaisesRegex(RuntimeError, "Scient-owned code"):
            await first._trusted_helper("eval")

    async def test_saved_source_runs_from_the_real_matlab_path(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "saved.m")
            code = "answer = 41;\n"
            source.write_bytes(code.encode("utf-8"))
            engine = FakeEngine(figure=False)
            instance, output = make_bridge(self, engine)
            instance._working_directory = os.path.realpath(directory)
            await instance._handle_execute(
                {
                    "code": code,
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "saved.m",
                        "sourceBytesHash": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "saved": True,
                    },
                },
                "saved-1",
            )
            await instance._execution_task
            self.assertEqual(engine.evaluated_paths, [str(source.resolve())])
            self.assertEqual(engine.evaluated_native_files, [True])
            self.assertNotIn(
                "Scient:SourceConflict",
                [message.get("payload", {}).get("name") for message in decode_frames(output.getvalue())],
            )

    async def test_saved_source_with_non_matlab_filename_uses_trusted_temporary_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "05_expected_error.m")
            code = "answer = 41;\n"
            source.write_bytes(code.encode("utf-8"))
            engine = FakeEngine(figure=False)
            instance, output = make_bridge(self, engine)
            instance._working_directory = os.path.realpath(directory)
            await instance._handle_execute(
                {
                    "code": code,
                    "sourceContext": {
                        "kind": "file",
                        "filePath": source.name,
                        "sourceBytesHash": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "saved": True,
                    },
                },
                "numbered-saved-source",
            )
            await instance._execution_task
            self.assertEqual(len(engine.evaluated_paths), 1)
            self.assertNotEqual(engine.evaluated_paths[0], str(source.resolve()))
            self.assertEqual(engine.evaluated_native_files, [False])
            self.assertEqual(decode_frames(output.getvalue())[-1]["payload"]["outcome"], "succeeded")

    def test_native_saved_source_names_are_conservative_matlab_identifiers(self):
        self.assertTrue(matlab_bridge.can_run_saved_matlab_source_natively("analysis_2.m"))
        for path in ("05_analysis.m", "analysis-file.m", "end.m", "analysé.m"):
            with self.subTest(path=path):
                self.assertFalse(matlab_bridge.can_run_saved_matlab_source_natively(path))

    async def test_saved_source_conflict_fails_without_native_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "saved.m")
            source.write_text("answer = 99;\n", encoding="utf-8")
            engine = FakeEngine(figure=False)
            instance, output = make_bridge(self, engine)
            instance._working_directory = os.path.realpath(directory)
            await instance._handle_execute(
                {
                    "code": "answer = 41;\n",
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "saved.m",
                        "sourceBytesHash": hashlib.sha256(b"answer = 41;\n").hexdigest(),
                        "saved": True,
                    },
                },
                "saved-conflict",
            )
            messages = decode_frames(output.getvalue())
            self.assertEqual(engine.evaluated_paths, [])
            self.assertEqual(messages[0]["type"], "accepted")
            self.assertEqual(messages[1]["payload"]["name"], "Scient:SourceConflict")
            self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_oversized_saved_source_is_rejected_with_bounded_read(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "oversized.m")
            source.write_bytes(b"x" * (matlab_bridge.MAX_CODE + 1))
            engine = FakeEngine(figure=False)
            instance, output = make_bridge(self, engine)
            instance._working_directory = os.path.realpath(directory)
            await instance._handle_execute(
                {
                    "code": "x;\n",
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "oversized.m",
                        "sourceBytesHash": hashlib.sha256(b"x;\n").hexdigest(),
                        "saved": True,
                    },
                },
                "oversized-source",
            )
            messages = decode_frames(output.getvalue())
            self.assertEqual(engine.evaluated_paths, [])
            self.assertIn("exceeds the bridge code limit", messages[1]["payload"]["value"])
            self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_saved_source_late_write_is_reported_without_claiming_native_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "saved.m")
            code = "answer = 41;\n"
            source.write_bytes(code.encode("utf-8"))

            def late_write():
                source.write_text("answer = 99;\n", encoding="utf-8")

            engine = FakeEngine(figure=False, on_evaluate=late_write)
            instance, output = make_bridge(self, engine)
            instance._working_directory = os.path.realpath(directory)
            await instance._handle_execute(
                {
                    "code": code,
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "saved.m",
                        "sourceBytesHash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                        "saved": True,
                    },
                },
                "saved-late-write",
            )
            await instance._execution_task
            messages = decode_frames(output.getvalue())
            errors = [message for message in messages if message["type"] == "error"]
            self.assertEqual(engine.evaluated_paths, [str(source.resolve())])
            self.assertTrue(any(message["payload"]["name"] == "Scient:SourceConflict" for message in errors))
            self.assertTrue(
                any(
                    "bytes MATLAB consumed cannot be proven" in message["payload"]["value"]
                    for message in errors
                )
            )
            self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_saved_selection_does_not_dispatch_the_whole_matlab_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "analysis.m")
            source.write_text("whole_file = 99;\n", encoding="utf-8")
            engine = FakeEngine(figure=False)
            instance, _ = make_bridge(self, engine)
            instance._working_directory = os.path.realpath(directory)
            code = "selected = 41;\n"
            await instance._handle_execute(
                {
                    "code": code,
                    "sourceContext": {
                        "kind": "selection",
                        "filePath": "analysis.m",
                        "sourceBytesHash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                        "saved": True,
                    },
                },
                "saved-selection-1",
            )
            await instance._execution_task
            self.assertEqual(len(engine.evaluated_paths), 1)
            self.assertNotEqual(engine.evaluated_paths[0], str(source.resolve()))

    def test_native_temp_submission_keeps_cwd_and_saved_file_keeps_source_identity(self):
        """Exercise the real evaluator's split snippet/native-file behavior."""
        executable = os.environ.get("SCIENT_TEST_MATLAB")
        if not executable:
            self.skipTest("SCIENT_TEST_MATLAB is not set")
        executable_path = Path(executable).expanduser()
        if not executable_path.is_file() or not os.access(executable_path, os.X_OK):
            self.skipTest(f"MATLAB executable is unavailable: {executable_path}")

        def matlab_quote(value):
            return value.replace("'", "''")

        helper_name = "scient_compute_eval_native_test"
        with tempfile.TemporaryDirectory(prefix="scient-matlab-native-eval-") as directory:
            root = Path(directory)
            helper_directory = root / "helpers"
            helper_directory.mkdir()
            helper = helper_directory / f"{helper_name}.m"
            helper.write_text(
                matlab_bridge.EVAL_HELPER.replace("__SCIENT_FUNCTION__", helper_name),
                encoding="utf-8",
            )
            temporary_submission = helper_directory / "scient_submission_native.m"
            temporary_submission.write_text(
                "scient_marker_file = fopen('snippet-cwd-marker.txt', 'w');\n"
                "fprintf(scient_marker_file, 'snippet');\n"
                "fclose(scient_marker_file);\n",
                encoding="utf-8",
            )
            source_directory = root / "src"
            source_directory.mkdir()
            sibling = source_directory / "native_sibling.m"
            sibling.write_text(
                "function scient_result = native_sibling()\n"
                "scient_result = 40;\n"
                "end\n",
                encoding="utf-8",
            )
            saved = source_directory / "saved.m"
            saved_marker = root / "saved-identity-marker.txt"
            saved.write_text(
                "saved_sibling_value = native_sibling();\n"
                "saved_local_value = native_local();\n"
                f"saved_marker_file = fopen('{matlab_quote(str(saved_marker))}', 'w');\n"
                "fprintf(saved_marker_file, '%d,%d', saved_sibling_value, saved_local_value);\n"
                "fclose(saved_marker_file);\n"
                "function scient_result = native_local()\n"
                "scient_result = 41;\n"
                "end\n",
                encoding="utf-8",
            )
            temporary_result = root / "temporary-cwd.txt"
            saved_result = root / "saved-receipt.json"
            wrapper = root / "native_eval_wrapper.m"
            wrapper.write_text(
                "\n".join(
                    [
                        f"addpath('{matlab_quote(str(helper_directory))}');",
                        f"{helper_name}('{matlab_quote(str(temporary_submission.resolve()))}', false);",
                        "scient_temporary_cwd = pwd;",
                        f"scient_cwd_file = fopen('{matlab_quote(str(temporary_result))}', 'w');",
                        "fprintf(scient_cwd_file, '%s', scient_temporary_cwd);",
                        "fclose(scient_cwd_file);",
                        f"scient_saved_receipt = {helper_name}('{matlab_quote(str(saved.resolve()))}', true);",
                        f"scient_saved_file = fopen('{matlab_quote(str(saved_result))}', 'w');",
                        "fwrite(scient_saved_file, scient_saved_receipt, 'char');",
                        "fclose(scient_saved_file);",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [str(executable_path), "-batch", "run('native_eval_wrapper.m')"],
                cwd=directory,
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            self.assertEqual(
                result.returncode,
                0,
                f"MATLAB native evaluator qualification failed.\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )
            self.assertEqual(
                (root / "temporary-cwd.txt").read_text(encoding="utf-8"),
                os.path.realpath(root),
            )
            self.assertTrue((root / "snippet-cwd-marker.txt").is_file())
            self.assertFalse((helper_directory / "snippet-cwd-marker.txt").exists())
            self.assertEqual(
                (root / "saved-identity-marker.txt").read_text(encoding="utf-8"), "40,41"
            )
            self.assertTrue(json.loads(saved_result.read_text(encoding="utf-8"))["ok"])

    async def test_matlab_tables_use_dataresource_json_with_text_fallback(self):
        table_json = json.dumps(
            {
                "schema": {"fields": [{"name": "answer"}]},
                "data": [{"answer": 41}],
                "scientPreview": {"truncated": False},
            },
            separators=(",", ":"),
        )
        engine = FakeEngine(
            figure=False,
            tables=[{"name": "results", "json": table_json, "text": "answer\n41\n"}],
        )
        instance, output = make_bridge(self, engine)
        await instance._handle_execute({"code": "answer = 41"}, "table-1")
        await instance._execution_task
        display = next(
            message
            for message in decode_frames(output.getvalue())
            if message["type"] == "display"
        )
        representations = display["payload"]["bundle"]["representations"]
        self.assertEqual(
            [representation["mediaType"] for representation in representations],
            ["application/vnd.dataresource+json", "text/plain"],
        )
        self.assertEqual(display["payload"]["displayId"], "matlab-table:results")

    def test_native_m02_and_m07_tables_are_bounded_and_well_formed(self):
        """Qualify the real helper against the QA MATLAB table stress cases."""
        executable = os.environ.get("SCIENT_TEST_MATLAB")
        if not executable:
            self.skipTest("SCIENT_TEST_MATLAB is not set")
        executable_path = Path(executable).expanduser()
        if not executable_path.is_file() or not os.access(executable_path, os.X_OK):
            self.skipTest(f"MATLAB executable is unavailable: {executable_path}")
        fixture_scripts = {
            "M02_tables_files.m": """%% Native table/timetable and file round-trip case
qa_out = fullfile(pwd, 'qa-output');
if ~isfolder(qa_out), mkdir(qa_out); end
qa_time = datetime(2026,9,10,0,0,0,'TimeZone','UTC') + minutes((0:5)');
qa_value = [1; NaN; 3; 4; 5; 6];
qa_group = categorical(["control";"treated";"control";"treated";"control";"treated"]);
qa_table = table(qa_time, qa_value, qa_group, 'VariableNames', {'time','value','group'});
qa_timetable = table2timetable(qa_table);
writetable(qa_table, fullfile(qa_out, 'matlab-table.csv'));
qa_csv = readtable(fullfile(qa_out, 'matlab-table.csv'));
assert(height(qa_timetable) == 6 && height(qa_csv) == 6);
qa_long_text = {repmat('x', 1, 1000)};
qa_datetime_scalar = datetime(2026,9,10,0,0,0,'TimeZone','UTC');
qa_unsafe_integer = uint64(9007199254740992);
qa_nonscalar = {[1 2 3]};
qa_scalar_table = table(qa_long_text, qa_datetime_scalar, qa_unsafe_integer, qa_nonscalar, ...
    'VariableNames', {'long_text','datetime_scalar','unsafe_integer','nonscalar'});
disp(qa_table);
disp('M02_PASS');
""",
            "M07_bounded_output.m": """%% Native bounded-output case
qa_big_table = table((1:5000)', sin((1:5000)'), 'VariableNames', {'sample','value'});
for qa_i = 1:2000
    fprintf('MATLAB QA bounded output %04d: synthetic sample\\n', qa_i);
end
disp(qa_big_table(1:8,:));
assert(height(qa_big_table) == 5000);
disp('M07_PASS');
""",
        }
        fixture_names = tuple(fixture_scripts)

        helper_name = "scient_compute_tables_native_test"
        with tempfile.TemporaryDirectory(prefix="scient-matlab-native-tables-") as directory:
            root = Path(directory)
            helper = root / f"{helper_name}.m"
            helper.write_text(
                matlab_bridge.TABLES_HELPER.replace("__SCIENT_FUNCTION__", helper_name),
                encoding="utf-8",
            )
            for fixture_name, fixture_source in fixture_scripts.items():
                (root / fixture_name).write_text(fixture_source, encoding="utf-8")
            wrapper = root / "native_table_wrapper.m"
            wrapper.write_text(
                "\n".join(
                    [
                        f"run('{fixture_names[0]}');",
                        f"scient_m02_json = {helper_name}(100, 20);",
                        "scient_m02_file = fopen('m02-helper.json', 'w');",
                        "assert(scient_m02_file ~= -1);",
                        "fwrite(scient_m02_file, scient_m02_json, 'char');",
                        "fclose(scient_m02_file);",
                        "clear;",
                        f"run('{fixture_names[1]}');",
                        f"scient_m07_json = {helper_name}(100, 20);",
                        "scient_m07_file = fopen('m07-helper.json', 'w');",
                        "assert(scient_m07_file ~= -1);",
                        "fwrite(scient_m07_file, scient_m07_json, 'char');",
                        "fclose(scient_m07_file);",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            result = subprocess.run(
                [str(executable_path), "-batch", "run('native_table_wrapper.m')"],
                cwd=directory,
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            self.assertEqual(
                result.returncode,
                0,
                f"MATLAB native table qualification failed.\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )
            self.assertIn("M02_PASS", result.stdout)
            self.assertIn("M07_PASS", result.stdout)

            m02_payload = json.loads((root / "m02-helper.json").read_text(encoding="utf-8"))
            m07_payload = json.loads((root / "m07-helper.json").read_text(encoding="utf-8"))

            def entries(payload):
                raw = payload.get("tables")
                return [raw] if isinstance(raw, dict) else raw

            m02_tables = entries(m02_payload)
            self.assertIsInstance(m02_tables, list)
            self.assertEqual(
                {entry["name"] for entry in m02_tables},
                {"qa_table", "qa_csv", "qa_timetable", "qa_scalar_table"},
            )
            for entry in m02_tables:
                decoded = json.loads(entry["json"])
                self.assertIn("schema", decoded)
                self.assertIn("fields", decoded["schema"])
                self.assertNotIn("data", decoded["schema"])
                self.assertIn("data", decoded)
                self.assertLessEqual(len(decoded["schema"]["fields"]), matlab_bridge.MAX_TABLE_COLUMNS)
                self.assertLessEqual(len(decoded["data"]), matlab_bridge.MAX_TABLE_ROWS)
                self.assertLessEqual(
                    len(entry["text"].encode("utf-8")), matlab_bridge.MAX_TABLE_TEXT
                )

            scalar_entry = next(entry for entry in m02_tables if entry["name"] == "qa_scalar_table")
            scalar_row = json.loads(scalar_entry["json"])["data"][0]
            self.assertLessEqual(len(scalar_row["long_text"]), 257)
            self.assertIsInstance(scalar_row["datetime_scalar"], str)
            self.assertEqual(scalar_row["unsafe_integer"], "9007199254740992")
            self.assertIsNone(scalar_row["nonscalar"])
            self.assertIn("JavaScript safe range", scalar_entry["warning"])

            m07_tables = entries(m07_payload)
            self.assertIsInstance(m07_tables, list)
            self.assertEqual([entry["name"] for entry in m07_tables], ["qa_big_table"])
            m07_table = json.loads(m07_tables[0]["json"])
            self.assertEqual(len(m07_table["data"]), matlab_bridge.MAX_TABLE_ROWS)
            self.assertLessEqual(
                len(m07_table["schema"]["fields"]), matlab_bridge.MAX_TABLE_COLUMNS
            )
            self.assertTrue(m07_table["scientPreview"]["truncated"])
            self.assertTrue(m07_payload["truncated"])
            self.assertLessEqual(
                len(m07_tables[0]["text"].encode("utf-8")), matlab_bridge.MAX_TABLE_TEXT
            )

    async def test_figure_identity_emits_update_and_close_facts(self):
        engine = FakeEngine()
        instance, output = make_bridge(self, engine)
        await instance._handle_execute({"code": "plot(1)"}, "figure-1")
        await instance._execution_task
        first_messages = decode_frames(output.getvalue())
        first_display = next(message for message in first_messages if message["type"] == "display")
        self.assertEqual(first_display["payload"]["kind"], "display-data")
        self.assertIn(
            "application/vnd.mathworks.matlab.figure",
            [item["mediaType"] for item in first_display["payload"]["bundle"]["representations"]],
        )

        before = len(first_messages)
        await instance._handle_execute({"code": "plot(1)"}, "figure-2")
        await instance._execution_task
        second_messages = decode_frames(output.getvalue())
        self.assertEqual(
            [message["type"] for message in second_messages[before:]],
            ["accepted", "stream", "execution-complete"],
        )

        engine.figure = False
        before = len(second_messages)
        await instance._handle_execute({"code": "close all"}, "figure-3")
        await instance._execution_task
        third_messages = decode_frames(output.getvalue())[before:]
        close_update = next(message for message in third_messages if message["type"] == "display")
        self.assertEqual(close_update["payload"]["kind"], "display-update")
        self.assertEqual(close_update["payload"]["displayId"], "matlab-figure:1")

    def test_captured_png_must_be_contained_regular_bounded_png(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            valid = Path(directory, "figure.png")
            valid.write_bytes(matlab_bridge.PNG_SIGNATURE + b"pixels")
            self.assertEqual(
                matlab_bridge.read_captured_png(directory, str(valid)), valid.read_bytes()
            )

            outside = Path(other, "outside.png")
            outside.write_bytes(matlab_bridge.PNG_SIGNATURE + b"outside")
            with self.assertRaisesRegex(ValueError, "outside the capture directory"):
                matlab_bridge.read_captured_png(directory, str(outside))

            link = Path(directory, "linked.png")
            link.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "outside the capture directory"):
                matlab_bridge.read_captured_png(directory, str(link))

            invalid = Path(directory, "invalid.png")
            invalid.write_bytes(b"not-a-png")
            with self.assertRaisesRegex(ValueError, "not a PNG"):
                matlab_bridge.read_captured_png(directory, str(invalid))

            oversized = Path(directory, "oversized.png")
            with oversized.open("wb") as stream:
                stream.write(matlab_bridge.PNG_SIGNATURE)
                stream.truncate(matlab_bridge.MAX_PNG_BYTES + 1)
            with self.assertRaisesRegex(ValueError, "exceeded"):
                matlab_bridge.read_captured_png(directory, str(oversized))

    def test_png_hash_ignores_ancillary_metadata_but_not_pixels(self):
        def chunk(kind, value):
            return struct.pack(">I", len(value)) + kind + value + b"\0\0\0\0"

        signature = b"\x89PNG\r\n\x1a\n"
        first = signature + chunk(b"IHDR", b"header") + chunk(b"tEXt", b"one") + chunk(
            b"IDAT", b"pixels"
        ) + chunk(b"IEND", b"")
        second = signature + chunk(b"IHDR", b"header") + chunk(b"tEXt", b"two") + chunk(
            b"IDAT", b"pixels"
        ) + chunk(b"IEND", b"")
        changed = signature + chunk(b"IHDR", b"header") + chunk(
            b"IDAT", b"different"
        ) + chunk(b"IEND", b"")
        self.assertEqual(
            matlab_bridge.png_content_hash(first), matlab_bridge.png_content_hash(second)
        )
        self.assertNotEqual(
            matlab_bridge.png_content_hash(first), matlab_bridge.png_content_hash(changed)
        )


if __name__ == "__main__":
    unittest.main()
