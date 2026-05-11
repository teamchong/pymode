"""Rewrite preimported packages' __path__ from wizer-time paths to runtime
zip-mount paths so submodule lookups work.

Must be imported AFTER all third-party preimports in pymode_wizer.c so the
packages we want to rewrite are already in sys.modules. The wizer snapshot
freezes the rewritten __path__ values, which point at /stdlib/site-packages.zip
and /stdlib/extension-site-packages.zip — valid only at runtime, but that's
when the lookups happen.
"""

import sys

_SP = "/stdlib/site-packages.zip"
_EXT = "/stdlib/extension-site-packages.zip"


def _rewrite_path_entry(entry):
    if not isinstance(entry, str):
        return entry
    if entry.startswith("/wizer-ext-sp/"):
        return _EXT + "/" + entry[len("/wizer-ext-sp/"):]
    if entry == "/wizer-ext-sp":
        return _EXT
    if entry.startswith("/wizer-sp/"):
        return _SP + "/" + entry[len("/wizer-sp/"):]
    if entry == "/wizer-sp":
        return _SP
    return entry


for mod in list(sys.modules.values()):
    path_attr = getattr(mod, "__path__", None)
    if not path_attr:
        continue
    try:
        entries = list(path_attr)
    except TypeError:
        continue
    rewritten = [_rewrite_path_entry(e) for e in entries]
    if rewritten != entries:
        try:
            mod.__path__ = rewritten
        except (AttributeError, TypeError):
            pass
