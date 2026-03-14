"""curses polyfill for WASM — terminal UI interface constants and functions."""

class error(Exception): pass

ERR = -1
OK = 0

def initscr():
    raise error("curses: no terminal available in WASM runtime")

def wrapper(func, *args, **kwargs):
    raise error("curses: no terminal available in WASM runtime")

def endwin(): pass
def isendwin(): return True
def start_color(): pass
def use_default_colors(): pass
def cbreak(): pass
def nocbreak(): pass
def echo(): pass
def noecho(): pass
def raw(): pass
def noraw(): pass
def curs_set(visibility): pass
def has_colors(): return False
def can_change_color(): return False
def color_pair(n): return 0
def init_pair(pair_number, fg, bg): pass

COLOR_BLACK = 0
COLOR_RED = 1
COLOR_GREEN = 2
COLOR_YELLOW = 3
COLOR_BLUE = 4
COLOR_MAGENTA = 5
COLOR_CYAN = 6
COLOR_WHITE = 7

A_NORMAL = 0
A_BOLD = 2097152
A_UNDERLINE = 131072
A_REVERSE = 262144
