"""tkinter polyfill for WASM — Tk GUI interface.
Import succeeds; widget creation raises TclError since there's no display.
"""

class TclError(Exception): pass

def _get_default_root(what=None):
    raise TclError("no display available in WASM runtime")

class Tk:
    def __init__(self, *args, **kwargs):
        raise TclError("no display available in WASM runtime")

class Toplevel:
    def __init__(self, *args, **kwargs):
        raise TclError("no display available in WASM runtime")

class Widget:
    def __init__(self, *args, **kwargs):
        raise TclError("no display available in WASM runtime")

class Frame(Widget): pass
class Label(Widget): pass
class Button(Widget): pass
class Entry(Widget): pass
class Text(Widget): pass
class Canvas(Widget): pass
class Listbox(Widget): pass
class Scrollbar(Widget): pass
class Menu(Widget): pass
class Menubutton(Widget): pass
class Checkbutton(Widget): pass
class Radiobutton(Widget): pass
class Scale(Widget): pass
class Spinbox(Widget): pass

END = "end"
LEFT = "left"
RIGHT = "right"
TOP = "top"
BOTTOM = "bottom"
CENTER = "center"
BOTH = "both"
X = "x"
Y = "y"
NONE = "none"
NORMAL = "normal"
DISABLED = "disabled"
HIDDEN = "hidden"
TRUE = True
FALSE = False
YES = True
NO = False

class Variable:
    def __init__(self, master=None, value=None, name=None):
        self._value = value
    def get(self):
        return self._value
    def set(self, value):
        self._value = value

class StringVar(Variable): pass
class IntVar(Variable): pass
class DoubleVar(Variable): pass
class BooleanVar(Variable): pass
