"""Analytics service — Python functions callable via DO RPC.

This module runs inside a PyMode Durable Object. TypeScript workers
call these functions directly via PythonDO.callFunction() — no HTTP
serialization, no request/response boilerplate.

Usage from TypeScript:
    const result = await pythonDO.callFunction("src.analytics", "summarize", {
        values: [10, 20, 30, 40, 50]
    });
    // result.returnValue === { mean: 30.0, median: 30.0, std: 14.14, ... }
"""

import json
import math


def summarize(values):
    """Compute summary statistics for a list of numbers."""
    if not values:
        return {"error": "empty input"}

    n = len(values)
    mean = sum(values) / n
    sorted_vals = sorted(values)

    if n % 2 == 0:
        median = (sorted_vals[n // 2 - 1] + sorted_vals[n // 2]) / 2
    else:
        median = sorted_vals[n // 2]

    variance = sum((x - mean) ** 2 for x in values) / n
    std = math.sqrt(variance)

    return {
        "count": n,
        "mean": round(mean, 4),
        "median": round(median, 4),
        "std": round(std, 4),
        "min": min(values),
        "max": max(values),
        "sum": sum(values),
    }


def tokenize(text, pattern=None):
    """Tokenize text using regex (native C extension)."""
    import regex
    if pattern is None:
        pattern = r"\p{L}+"
    tokens = regex.findall(pattern, text)
    return {
        "tokens": tokens,
        "count": len(tokens),
        "unique": len(set(tokens)),
    }


def render_template(template, context):
    """Render a Jinja2 template with the given context."""
    import jinja2
    tmpl = jinja2.Template(template)
    return tmpl.render(**context)
