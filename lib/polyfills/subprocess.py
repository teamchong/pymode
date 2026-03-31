"""Subprocess polyfill for PyMode WASM runtime.

Provides the subprocess API that hermes-agent and other packages expect.
Popen routes Python scripts through the WASM interpreter. Non-Python
commands return appropriate results (e.g., pip reports packages are pre-bundled).

For real parallel execution, use pymode.parallel (ThreadDO pool).
"""

import sys
import io

__all__ = [
    "Popen", "PIPE", "STDOUT", "DEVNULL",
    "run", "call", "check_call", "check_output",
    "CalledProcessError", "SubprocessError", "TimeoutExpired",
    "CompletedProcess",
]

PIPE = -1
STDOUT = -2
DEVNULL = -3

class SubprocessError(Exception):
    pass

class CalledProcessError(SubprocessError):
    def __init__(self, returncode, cmd, output=None, stderr=None):
        self.returncode = returncode
        self.cmd = cmd
        self.output = output
        self.stdout = output
        self.stderr = stderr

    def __str__(self):
        return f"Command '{self.cmd}' returned non-zero exit status {self.returncode}."

class TimeoutExpired(SubprocessError):
    def __init__(self, cmd, timeout, output=None, stderr=None):
        self.cmd = cmd
        self.timeout = timeout
        self.output = output
        self.stdout = output
        self.stderr = stderr

class CompletedProcess:
    def __init__(self, args, returncode, stdout=None, stderr=None):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def check_returncode(self):
        if self.returncode:
            raise CalledProcessError(
                self.returncode, self.args, self.stdout, self.stderr
            )

    def __repr__(self):
        return (
            f"CompletedProcess(args={self.args!r}, returncode={self.returncode})"
        )


class Popen:
    """Synchronous process execution in WASM.

    Python commands are executed via exec(). Other commands return
    appropriate mock results.
    """

    def __class_getitem__(cls, item):
        return cls

    def __init__(self, args, bufsize=-1, executable=None, stdin=None,
                 stdout=None, stderr=None, preexec_fn=None, close_fds=True,
                 shell=False, cwd=None, env=None, universal_newlines=None,
                 startupinfo=None, creationflags=0, restore_signals=True,
                 start_new_session=False, pass_fds=(), *, text=None,
                 encoding=None, errors=None, user=None, group=None,
                 extra_groups=None, umask=-1, pipesize=-1, process_group=None):

        if isinstance(args, str):
            self.args = args
            cmd_parts = args.split()
        else:
            self.args = list(args)
            cmd_parts = self.args

        self._text = text or universal_newlines
        self._encoding = encoding
        self.returncode = None
        self.pid = 1

        # Capture streams
        self._stdout_data = b""
        self._stderr_data = b""

        # Execute immediately
        self._execute(cmd_parts, stdin, env, cwd)

        # Set up stdout/stderr pipes
        if stdout == PIPE:
            data = self._stdout_data
            if self._text:
                self.stdout = io.StringIO(data.decode(encoding or "utf-8", errors="replace"))
            else:
                self.stdout = io.BytesIO(data)
        else:
            self.stdout = None

        if stderr == PIPE:
            data = self._stderr_data
            if self._text:
                self.stderr = io.StringIO(data.decode(encoding or "utf-8", errors="replace"))
            else:
                self.stderr = io.BytesIO(data)
        elif stderr == STDOUT and stdout == PIPE:
            self.stderr = None
            # Merge stderr into stdout
        else:
            self.stderr = None

    def _execute(self, cmd_parts, stdin, env, cwd):
        """Execute the command synchronously."""
        if not cmd_parts:
            self.returncode = 1
            self._stderr_data = b"subprocess: empty command\n"
            return

        cmd = cmd_parts[0]
        # Strip path
        if "/" in cmd:
            cmd = cmd.rsplit("/", 1)[-1]

        if cmd in ("python", "python3", sys.executable):
            self._exec_python(cmd_parts[1:], stdin, env, cwd)
        elif cmd in ("pip", "pip3"):
            self._stdout_data = b"pip: packages are pre-bundled in site-packages.zip\n"
            self.returncode = 0
        elif cmd == "git":
            self._exec_git(cmd_parts[1:])
        elif cmd == "which":
            target = cmd_parts[1] if len(cmd_parts) > 1 else ""
            if target in ("python", "python3"):
                self._stdout_data = b"/usr/local/bin/python3\n"
                self.returncode = 0
            else:
                self._stderr_data = f"which: no {target} in PATH\n".encode()
                self.returncode = 1
        elif cmd in ("echo",):
            self._stdout_data = " ".join(cmd_parts[1:]).encode() + b"\n"
            self.returncode = 0
        elif cmd == "uname":
            flags = " ".join(cmd_parts[1:])
            if "-r" in flags and "-s" in flags:
                self._stdout_data = b"WASI 0.0.0\n"
            elif "-s" in flags:
                self._stdout_data = b"WASI\n"
            elif "-r" in flags:
                self._stdout_data = b"0.0.0\n"
            elif "-m" in flags:
                self._stdout_data = b"wasm32\n"
            else:
                self._stdout_data = b"WASI\n"
            self.returncode = 0
        elif cmd == "lsb_release":
            self._stderr_data = b"lsb_release: not available in WASM\n"
            self.returncode = 1
        elif cmd in ("true",):
            self.returncode = 0
        elif cmd in ("false",):
            self.returncode = 1
        elif cmd in ("cat", "ls", "mkdir", "rm", "cp", "mv", "touch", "chmod",
                     "head", "tail", "grep", "wc", "sort", "uniq", "tee"):
            # File operations — execute as Python
            script = f"import os, sys; os.system({' '.join(cmd_parts)!r})"
            self._exec_python_code(script, env, cwd)
        else:
            self._stderr_data = f"subprocess: command not available in WASM: {cmd}\n".encode()
            self.returncode = 127

    def _exec_python(self, args, stdin, env, cwd):
        """Execute python with arguments."""
        code = None
        script_file = None

        i = 0
        while i < len(args):
            if args[i] == "-c" and i + 1 < len(args):
                code = " ".join(args[i+1:])
                break
            elif args[i] == "-m" and i + 1 < len(args):
                code = f"import runpy; runpy.run_module('{args[i+1]}', run_name='__main__')"
                break
            elif not args[i].startswith("-"):
                script_file = args[i]
                break
            i += 1

        if script_file:
            try:
                with open(script_file, "r") as f:
                    code = f.read()
            except FileNotFoundError:
                self._stderr_data = f"python: can't open file '{script_file}'\n".encode()
                self.returncode = 2
                return

        if code:
            self._exec_python_code(code, env, cwd)
        else:
            self.returncode = 0

    def _exec_python_code(self, code, env, cwd):
        """Run Python code, capturing stdout/stderr."""
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        cap_out = io.StringIO()
        cap_err = io.StringIO()
        sys.stdout = cap_out
        sys.stderr = cap_err

        try:
            exec(compile(code, "<subprocess>", "exec"), {"__name__": "__main__"})
            self.returncode = 0
        except SystemExit as e:
            self.returncode = e.code if isinstance(e.code, int) else (1 if e.code else 0)
        except Exception:
            import traceback
            traceback.print_exc(file=cap_err)
            self.returncode = 1
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr

        self._stdout_data = cap_out.getvalue().encode()
        self._stderr_data = cap_err.getvalue().encode()

    def _exec_git(self, args):
        """Handle git commands."""
        if not args:
            self._stdout_data = b"git: WASM runtime (no real git)\n"
            self.returncode = 0
            return

        subcmd = args[0]
        if subcmd == "rev-parse":
            if "--show-toplevel" in args:
                self._stdout_data = b"/data\n"
                self.returncode = 0
            elif "--git-dir" in args:
                self._stderr_data = b"fatal: not a git repository\n"
                self.returncode = 128
            else:
                self.returncode = 0
        elif subcmd == "status":
            self._stdout_data = b"On branch main\nnothing to commit\n"
            self.returncode = 0
        elif subcmd == "log":
            self._stdout_data = b""
            self.returncode = 0
        else:
            self._stdout_data = b""
            self.returncode = 0

    def communicate(self, input=None, timeout=None):
        out = self._stdout_data if self.stdout else None
        err = self._stderr_data if self.stderr else None
        if self._text:
            enc = self._encoding or "utf-8"
            if out is not None:
                out = out.decode(enc, errors="replace")
            if err is not None:
                err = err.decode(enc, errors="replace")
        return (out, err)

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        pass

    def terminate(self):
        pass

    def send_signal(self, sig):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def __del__(self):
        pass


def run(args, *, capture_output=False, input=None, timeout=None, check=False,
        **kwargs):
    if capture_output:
        kwargs["stdout"] = PIPE
        kwargs["stderr"] = PIPE

    proc = Popen(args, **kwargs)
    stdout, stderr = proc.communicate(input=input, timeout=timeout)

    cp = CompletedProcess(args, proc.returncode, stdout, stderr)
    if check:
        cp.check_returncode()
    return cp


def call(args, **kwargs):
    return run(args, **kwargs).returncode


def check_call(args, **kwargs):
    return run(args, check=True, **kwargs).returncode


def check_output(args, **kwargs):
    return run(args, check=True, stdout=PIPE, **kwargs).stdout
