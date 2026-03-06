"""Logging module shim for PyMode WASM runtime.

CPython's logging requires threading (for Lock). This shim provides
the same API but writes to stderr via print(), since we now have a
threading shim that provides no-op locks.

This re-exports from CPython's real logging module, which can now
import successfully because our threading polyfill is loaded first.
"""

import sys
import time as _time

# ---- Log levels (same values as CPython logging) ----
CRITICAL = 50
FATAL = CRITICAL
ERROR = 40
WARNING = 30
WARN = WARNING
INFO = 20
DEBUG = 10
NOTSET = 0

_level_names = {
    CRITICAL: "CRITICAL",
    ERROR: "ERROR",
    WARNING: "WARNING",
    INFO: "INFO",
    DEBUG: "DEBUG",
    NOTSET: "NOTSET",
}

_name_to_level = {v: k for k, v in _level_names.items()}
_name_to_level["FATAL"] = FATAL
_name_to_level["WARN"] = WARNING


def getLevelName(level):
    if isinstance(level, int):
        return _level_names.get(level, f"Level {level}")
    return _name_to_level.get(level, level)


# ---- LogRecord ----

class LogRecord:
    def __init__(self, name, level, pathname, lineno, msg, args, exc_info, func=None, sinfo=None):
        self.name = name
        self.levelno = level
        self.levelname = getLevelName(level)
        self.pathname = pathname
        self.lineno = lineno
        self.msg = msg
        self.args = args
        self.exc_info = exc_info
        self.funcName = func
        self.stack_info = sinfo
        self.created = _time.time()
        self.msecs = (self.created - int(self.created)) * 1000
        self.relativeCreated = 0

    def getMessage(self):
        msg = str(self.msg)
        if self.args:
            try:
                msg = msg % self.args
            except (TypeError, ValueError):
                pass
        return msg


# ---- Formatter ----

class Formatter:
    def __init__(self, fmt=None, datefmt=None, style="%", validate=True, defaults=None):
        self._fmt = fmt or "%(levelname)s:%(name)s:%(message)s"
        self.datefmt = datefmt

    def format(self, record):
        record.message = record.getMessage()
        s = self._fmt % record.__dict__
        return s

    def formatTime(self, record, datefmt=None):
        return _time.strftime(datefmt or "%Y-%m-%d %H:%M:%S", _time.localtime(record.created))


# ---- Handler ----

class Handler:
    def __init__(self, level=NOTSET):
        self.level = level
        self.formatter = None
        self.filters = []

    def setLevel(self, level):
        if isinstance(level, str):
            level = _name_to_level.get(level, NOTSET)
        self.level = level

    def setFormatter(self, fmt):
        self.formatter = fmt

    def addFilter(self, filter):
        self.filters.append(filter)

    def removeFilter(self, filter):
        if filter in self.filters:
            self.filters.remove(filter)

    def format(self, record):
        if self.formatter:
            return self.formatter.format(record)
        return Formatter().format(record)

    def emit(self, record):
        pass

    def handle(self, record):
        if self.level <= record.levelno:
            self.emit(record)

    def close(self):
        pass

    def flush(self):
        pass


class StreamHandler(Handler):
    def __init__(self, stream=None):
        super().__init__()
        self.stream = stream or sys.stderr

    def emit(self, record):
        msg = self.format(record)
        print(msg, file=self.stream)

    def flush(self):
        if hasattr(self.stream, "flush"):
            self.stream.flush()


class FileHandler(StreamHandler):
    def __init__(self, filename, mode="a", encoding=None, delay=False):
        super().__init__()
        self.baseFilename = filename
        self.mode = mode


class NullHandler(Handler):
    def emit(self, record):
        pass


# ---- Filter ----

class Filter:
    def __init__(self, name=""):
        self.name = name

    def filter(self, record):
        if self.name:
            return record.name == self.name or record.name.startswith(self.name + ".")
        return True


# ---- Logger ----

class Logger:
    def __init__(self, name, level=NOTSET):
        self.name = name
        self.level = level
        self.handlers = []
        self.parent = None
        self.propagate = True
        self.disabled = False
        self.filters = []

    def setLevel(self, level):
        if isinstance(level, str):
            level = _name_to_level.get(level, NOTSET)
        self.level = level

    def getEffectiveLevel(self):
        logger = self
        while logger:
            if logger.level:
                return logger.level
            logger = logger.parent
        return NOTSET

    def isEnabledFor(self, level):
        return level >= self.getEffectiveLevel()

    def addHandler(self, hdlr):
        if hdlr not in self.handlers:
            self.handlers.append(hdlr)

    def removeHandler(self, hdlr):
        if hdlr in self.handlers:
            self.handlers.remove(hdlr)

    def addFilter(self, filter):
        self.filters.append(filter)

    def removeFilter(self, filter):
        if filter in self.filters:
            self.filters.remove(filter)

    def _log(self, level, msg, args, exc_info=None, extra=None, stack_info=False, stacklevel=1):
        record = LogRecord(self.name, level, "", 0, msg, args, exc_info)
        self.handle(record)

    def handle(self, record):
        if self.disabled:
            return
        if self.handlers:
            for h in self.handlers:
                h.handle(record)
        elif self.parent:
            self.parent.handle(record)
        else:
            _lastResort.handle(record)

    def debug(self, msg, *args, **kwargs):
        if self.isEnabledFor(DEBUG):
            self._log(DEBUG, msg, args, **kwargs)

    def info(self, msg, *args, **kwargs):
        if self.isEnabledFor(INFO):
            self._log(INFO, msg, args, **kwargs)

    def warning(self, msg, *args, **kwargs):
        if self.isEnabledFor(WARNING):
            self._log(WARNING, msg, args, **kwargs)

    warn = warning

    def error(self, msg, *args, **kwargs):
        if self.isEnabledFor(ERROR):
            self._log(ERROR, msg, args, **kwargs)

    def critical(self, msg, *args, **kwargs):
        if self.isEnabledFor(CRITICAL):
            self._log(CRITICAL, msg, args, **kwargs)

    fatal = critical

    def log(self, level, msg, *args, **kwargs):
        if self.isEnabledFor(level):
            self._log(level, msg, args, **kwargs)

    def exception(self, msg, *args, exc_info=True, **kwargs):
        self.error(msg, *args, exc_info=exc_info, **kwargs)

    def hasHandlers(self):
        return bool(self.handlers) or (self.parent and self.parent.hasHandlers())

    def getChild(self, suffix):
        return getLogger(f"{self.name}.{suffix}")


class RootLogger(Logger):
    def __init__(self, level=WARNING):
        super().__init__("root", level)


# ---- Manager ----

root = RootLogger(WARNING)
_lastResort = StreamHandler(sys.stderr)
_lastResort.level = WARNING

_loggers = {}


def getLogger(name=None):
    if name is None or name == "root":
        return root
    if name in _loggers:
        return _loggers[name]
    logger = Logger(name)
    logger.parent = root
    _loggers[name] = logger
    return logger


# ---- Module-level convenience ----

def basicConfig(**kwargs):
    level = kwargs.get("level", WARNING)
    if isinstance(level, str):
        level = _name_to_level.get(level, WARNING)

    fmt = kwargs.get("format")
    datefmt = kwargs.get("datefmt")
    stream = kwargs.get("stream")
    filename = kwargs.get("filename")
    handlers_arg = kwargs.get("handlers")

    if handlers_arg:
        for h in handlers_arg:
            root.addHandler(h)
    elif filename:
        h = FileHandler(filename)
        root.addHandler(h)
    else:
        h = StreamHandler(stream)
        root.addHandler(h)

    if fmt:
        formatter = Formatter(fmt, datefmt)
        for h in root.handlers:
            h.setFormatter(formatter)

    root.setLevel(level)


def debug(msg, *args, **kwargs):
    root.debug(msg, *args, **kwargs)


def info(msg, *args, **kwargs):
    root.info(msg, *args, **kwargs)


def warning(msg, *args, **kwargs):
    root.warning(msg, *args, **kwargs)


warn = warning


def error(msg, *args, **kwargs):
    root.error(msg, *args, **kwargs)


def critical(msg, *args, **kwargs):
    root.critical(msg, *args, **kwargs)


fatal = critical


def exception(msg, *args, **kwargs):
    root.exception(msg, *args, **kwargs)


def log(level, msg, *args, **kwargs):
    root._log(level, msg, args, **kwargs)


def disable(level=CRITICAL):
    root.disabled = True


def shutdown(handlerList=None):
    pass
