# CrewAI

**Status: Maybe (untested, heavy dependency tree)**

## What It Is

Multi-agent orchestration framework. Define "crews" of AI agents with
different roles, tools, and goals that collaborate to complete tasks.

## Viability Assessment

**In favor:**
- Agent logic is mostly HTTP orchestration (LLM API calls)
- Pure Python orchestration layer
- Would benefit from DO's stateful nature

**Against:**
- Heavy dependency tree (langchain, pydantic, plus its own deps)
- May exceed 10MB compressed package limit
- Unknown memory footprint — could push past 256MB DO limit
- Imports many stdlib modules that may need additional polyfills

## Dependencies (partial)

- langchain-core — works
- pydantic — works
- openai / litellm — untested, likely need polyfills
- instructor — untested
- embedchain — untested, likely too heavy

## Compared to LangGraph

| | LangGraph | CrewAI |
|---|-----------|--------|
| Dependency weight | Light (langchain-core only) | Heavy (many extras) |
| Architecture | Graph-based state machine | Role-based multi-agent |
| DO fit | Excellent (stateful graphs) | Good (stateful agents) |
| Viability on pymode | Likely works | Uncertain |

## Next Steps

1. Try installing with pymode-install.py, check total size
2. Identify which dependencies need polyfills
3. Test basic crew creation and role definition
4. Evaluate memory usage

## Recommendation

Start with LangGraph — it's lighter, built directly on langchain-core
(which is already working), and fits DO's stateful model perfectly.
Try CrewAI only if LangGraph doesn't meet your multi-agent needs.
