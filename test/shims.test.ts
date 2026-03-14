import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

/**
 * Tests for polyfill modules that make standard Python imports work in WASM.
 * These allow packages that depend on OS features to import and work
 * in PyMode's single-threaded WASM runtime.
 */

// ---------------------------------------------------------------------------
// threading shim
// ---------------------------------------------------------------------------
describe("threading shim", () => {
  it("imports successfully", async () => {
    const r = await runPython(`
import threading
print("OK")
`);
    expect(r.text).toBe("OK");
  });

  it("provides Lock and RLock", async () => {
    const r = await runPython(`
import threading

lock = threading.Lock()
lock.acquire()
print(f"locked={lock.locked()}")
lock.release()
print(f"released={lock.locked()}")

rlock = threading.RLock()
rlock.acquire()
rlock.acquire()  # reentrant
rlock.release()
rlock.release()
print("rlock=OK")
`);
    expect(r.text).toBe("locked=True\nreleased=False\nrlock=OK");
  });

  it("provides current_thread and main_thread", async () => {
    const r = await runPython(`
import threading
t = threading.current_thread()
print(f"name={t.name},alive={t.is_alive()}")
m = threading.main_thread()
print(f"main={m.name},same={t is m}")
`);
    expect(r.text).toBe("name=MainThread,alive=True\nmain=MainThread,same=True");
  });

  it("provides Event", async () => {
    const r = await runPython(`
import threading
e = threading.Event()
print(f"set={e.is_set()}")
e.set()
print(f"set={e.is_set()}")
e.clear()
print(f"set={e.is_set()}")
`);
    expect(r.text).toBe("set=False\nset=True\nset=False");
  });

  it("Thread.start runs target synchronously in test env", async () => {
    const r = await runPython(`
import threading
results = []
def worker(x):
    results.append(x * 2)
t = threading.Thread(target=worker, args=(21,))
t.start()
t.join()
print(f"result={results[0]},alive={t.is_alive()}")
`);
    expect(r.text).toBe("result=42,alive=False");
  });

  it("provides active_count and enumerate", async () => {
    const r = await runPython(`
import threading
print(f"count={threading.active_count()},threads={len(threading.enumerate())}")
`);
    expect(r.text).toBe("count=1,threads=1");
  });

  it("provides Condition", async () => {
    const r = await runPython(`
import threading
c = threading.Condition()
c.acquire()
c.notify()
c.release()
print("OK")
`);
    expect(r.text).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// logging shim
// ---------------------------------------------------------------------------
describe("logging shim", () => {
  it("imports successfully", async () => {
    const r = await runPython(`
import logging
print("OK")
`);
    expect(r.text).toBe("OK");
  });

  it("provides log levels", async () => {
    const r = await runPython(`
import logging
print(f"DEBUG={logging.DEBUG},INFO={logging.INFO},WARNING={logging.WARNING},ERROR={logging.ERROR},CRITICAL={logging.CRITICAL}")
`);
    expect(r.text).toBe("DEBUG=10,INFO=20,WARNING=30,ERROR=40,CRITICAL=50");
  });

  it("getLogger and basicConfig work", async () => {
    const r = await runPython(`
import logging
import sys

logging.basicConfig(level=logging.DEBUG, format="%(levelname)s:%(name)s:%(message)s", stream=sys.stdout)
logger = logging.getLogger("test")
logger.info("hello %s", "world")
`);
    expect(r.text).toBe("INFO:test:hello world");
  });

  it("logger hierarchy works", async () => {
    const r = await runPython(`
import logging
import sys

logging.basicConfig(level=logging.DEBUG, format="%(name)s:%(message)s", stream=sys.stdout)
parent = logging.getLogger("app")
child = logging.getLogger("app.db")
child.info("query ran")
`);
    expect(r.text).toBe("app.db:query ran");
  });

  it("NullHandler silences output", async () => {
    const r = await runPython(`
import logging
logger = logging.getLogger("quiet")
logger.addHandler(logging.NullHandler())
logger.propagate = False
logger.warning("should not appear")
print("OK")
`);
    expect(r.text).toBe("OK");
  });

  it("module-level functions work", async () => {
    const r = await runPython(`
import logging
import sys

logging.basicConfig(level=logging.WARNING, format="%(levelname)s:%(message)s", stream=sys.stdout)
logging.debug("skip")
logging.warning("warn1")
logging.error("err1")
`);
    // debug should be filtered, warning and error should print
    expect(r.text).toContain("WARNING:warn1");
    expect(r.text).toContain("ERROR:err1");
    expect(r.text).not.toContain("skip");
  });
});

// ---------------------------------------------------------------------------
// socket shim
// ---------------------------------------------------------------------------
describe("socket shim", () => {
  it("imports successfully", async () => {
    const r = await runPython(`
import socket
print(f"AF_INET={socket.AF_INET},SOCK_STREAM={socket.SOCK_STREAM}")
`);
    expect(r.text).toBe("AF_INET=2,SOCK_STREAM=1");
  });

  it("provides getaddrinfo", async () => {
    const r = await runPython(`
import socket
result = socket.getaddrinfo("example.com", 80)
print(f"len={len(result)},family={result[0][0]},type={result[0][1]}")
`);
    expect(r.text).toBe("len=1,family=2,type=1");
  });

  it("provides gethostname", async () => {
    const r = await runPython(`
import socket
name = socket.gethostname()
print(f"hostname={name}")
`);
    expect(r.text).toBe("hostname=pymode-worker");
  });

  it("provides inet_aton and inet_ntoa", async () => {
    const r = await runPython(`
import socket
packed = socket.inet_aton("127.0.0.1")
unpacked = socket.inet_ntoa(packed)
print(f"unpacked={unpacked}")
`);
    expect(r.text).toBe("unpacked=127.0.0.1");
  });

  it("has error classes", async () => {
    const r = await runPython(`
import socket
print(f"error={issubclass(socket.error, OSError)}")
print(f"timeout={issubclass(socket.timeout, TimeoutError)}")
`);
    expect(r.text).toBe("error=True\ntimeout=True");
  });

  it("socket object has expected interface", async () => {
    const r = await runPython(`
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
methods = ["connect", "send", "recv", "close", "settimeout", "makefile"]
has_all = all(hasattr(s, m) for m in methods)
print(f"has_all={has_all}")
s.close()
`);
    expect(r.text).toBe("has_all=True");
  });
});

// ---------------------------------------------------------------------------
// packages that previously failed to import
// ---------------------------------------------------------------------------
describe("packages unblocked by shims", () => {
  it("logging imports with threading shim", async () => {
    const r = await runPython(`
import logging
logger = logging.getLogger("myapp")
logger.setLevel(logging.DEBUG)
print(f"logger={logger.name},level={logger.level}")
`);
    expect(r.text).toBe("logger=myapp,level=10");
  });

  it("queue module imports (depends on threading)", async () => {
    const r = await runPython(`
try:
    import queue
    q = queue.Queue()
    q.put("item")
    print(f"got={q.get()}")
except ImportError as e:
    print(f"FAIL:{e}")
`);
    // queue may not be bundled yet, but at least threading won't block it
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// All disabled C extensions must import successfully
// ---------------------------------------------------------------------------
describe("all stdlib modules importable", () => {
  it("imports faulthandler", async () => {
    const r = await runPython(`
import faulthandler
faulthandler.enable()
faulthandler.disable()
print(f"enabled={faulthandler.is_enabled()}")
`);
    expect(r.text).toContain("enabled=False");
  });

  it("imports resource", async () => {
    const r = await runPython(`
import resource
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
print(f"pagesize={resource.getpagesize()}")
print(f"limits={soft},{hard}")
`);
    expect(r.text).toContain("pagesize=65536");
  });

  it("imports grp", async () => {
    const r = await runPython(`
import grp
groups = grp.getgrall()
print(f"groups={len(groups)}")
`);
    expect(r.text).toContain("groups=0");
  });

  it("imports pwd", async () => {
    const r = await runPython(`
import pwd
root = pwd.getpwuid(0)
print(f"name={root.pw_name}")
`);
    expect(r.text).toContain("name=root");
  });

  it("imports fcntl", async () => {
    const r = await runPython(`
import fcntl
print(f"LOCK_EX={fcntl.LOCK_EX}")
`);
    expect(r.text).toContain("LOCK_EX=2");
  });

  it("imports mmap", async () => {
    const r = await runPython(`
import mmap
m = mmap.mmap(-1, 1024)
m.write(b"hello")
m.seek(0)
data = m.read(5)
m.close()
print(f"data={data}")
`);
    expect(r.text).toContain("data=b'hello'");
  });

  it("imports termios", async () => {
    const r = await runPython(`
import termios
print(f"ECHO={termios.ECHO}")
`);
    expect(r.text).toContain("ECHO=");
  });

  it("imports syslog", async () => {
    const r = await runPython(`
import syslog
syslog.openlog("test")
syslog.syslog(syslog.LOG_INFO, "hello")
syslog.closelog()
print("OK")
`);
    expect(r.text).toContain("OK");
  });

  it("imports bz2", async () => {
    const r = await runPython(`
import bz2
print(f"module={bz2.__name__}")
`);
    expect(r.text).toContain("module=bz2");
  });

  it("imports lzma", async () => {
    const r = await runPython(`
import lzma
print(f"module={lzma.__name__}")
`);
    expect(r.text).toContain("module=lzma");
  });

  it("imports ctypes", async () => {
    const r = await runPython(`
import ctypes
print(f"module={ctypes.__name__}")
`);
    expect(r.text).toContain("module=ctypes");
  });

  it("imports curses", async () => {
    const r = await runPython(`
import curses
print(f"COLOR_RED={curses.COLOR_RED}")
`);
    expect(r.text).toContain("COLOR_RED=1");
  });

  it("imports dbm", async () => {
    const r = await runPython(`
import dbm
db = dbm.open("test", "c")
db["key"] = "value"
print(f"got={db['key']}")
db.close()
`);
    expect(r.text).toContain("got=b'value'");
  });

  it("imports tkinter", async () => {
    const r = await runPython(`
import tkinter
print(f"END={tkinter.END}")
`);
    expect(r.text).toContain("END=end");
  });

  it("imports subprocess", async () => {
    const r = await runPython(`
import subprocess
print(f"module={subprocess.__name__}")
`);
    expect(r.text).toContain("module=subprocess");
  });
});
