"""PyMode Workflows — durable multi-step execution.

Define workflows with @step decorators. Each step runs durably:
retried on failure, skipped on resume, with results persisted.

    from pymode.workflows import Workflow

    app = Workflow("order-processing")

    @app.step(retries=3)
    def fetch_customer(ctx):
        return ctx.env.CUSTOMERS_KV.get(ctx.input["customer_id"], type="json")

    @app.step(retries=2, backoff=2.0)
    def process_payment(ctx):
        customer = ctx.results["fetch_customer"]
        return {"charged": True, "customer": customer["name"]}

    @app.step
    def send_confirmation(ctx):
        result = ctx.results["process_payment"]
        ctx.env.AUDIT_KV.put(f"order:{ctx.workflow_id}", json.dumps(result))
        return {"status": "confirmed"}
"""

import json
import time
import traceback


class StepConfig:
    """Configuration for a single workflow step."""

    def __init__(self, name, fn, retries=0, backoff=1.0, timeout=None):
        self.name = name
        self.fn = fn
        self.retries = retries
        self.backoff = backoff
        self.timeout = timeout


class StepContext:
    """Passed to each step function with workflow state."""

    def __init__(self, workflow_id, input_data, results, env):
        self.workflow_id = workflow_id
        self.input = input_data
        self.results = results
        self.env = env


class WorkflowResult:
    """Result of a workflow execution."""

    def __init__(self, workflow_id, status, results, error=None):
        self.workflow_id = workflow_id
        self.status = status
        self.results = results
        self.error = error

    def to_dict(self):
        d = {
            "workflow_id": self.workflow_id,
            "status": self.status,
            "results": self.results,
        }
        if self.error:
            d["error"] = self.error
        return d


class Workflow:
    """Define and execute multi-step durable workflows.

    Steps execute sequentially. Each step receives a StepContext with
    access to previous step results, workflow input, and env bindings.
    Failed steps are retried with exponential backoff.

    Usage:
        app = Workflow("my-workflow")

        @app.step
        def step_one(ctx):
            return {"data": "value"}

        @app.step(retries=3, backoff=2.0)
        def step_two(ctx):
            prev = ctx.results["step_one"]
            return process(prev)

        # Run via POST /workflow/run
        # Resume via POST /workflow/resume
    """

    def __init__(self, name):
        self.name = name
        self.steps = []

    def step(self, fn=None, *, retries=0, backoff=1.0, timeout=None):
        """Decorator to register a workflow step."""
        def decorator(f):
            config = StepConfig(
                name=f.__name__,
                fn=f,
                retries=retries,
                backoff=backoff,
                timeout=timeout,
            )
            self.steps.append(config)
            return f

        if fn is not None:
            return decorator(fn)
        return decorator

    def run(self, workflow_id, input_data, env, journal=None):
        """Execute the workflow, resuming from journal if provided."""
        if journal is None:
            journal = {
                "workflow_id": workflow_id,
                "status": "in_progress",
                "completed_steps": [],
                "results": {},
                "current_step": None,
                "error": None,
            }

        results = dict(journal.get("results", {}))
        completed = set(journal.get("completed_steps", []))

        for step_config in self.steps:
            if step_config.name in completed:
                continue

            journal["current_step"] = step_config.name
            ctx = StepContext(workflow_id, input_data, results, env)

            last_error = None
            max_attempts = step_config.retries + 1

            for attempt in range(max_attempts):
                try:
                    result = step_config.fn(ctx)
                    results[step_config.name] = result
                    completed.add(step_config.name)
                    journal["completed_steps"] = list(completed)
                    journal["results"] = results
                    last_error = None
                    break
                except Exception as e:
                    last_error = {
                        "step": step_config.name,
                        "attempt": attempt + 1,
                        "max_attempts": max_attempts,
                        "error": str(e),
                        "traceback": traceback.format_exc(),
                    }
                    if attempt < max_attempts - 1:
                        delay = step_config.backoff * (2 ** attempt)
                        time.sleep(delay)

            if last_error:
                journal["status"] = "failed"
                journal["error"] = last_error
                return WorkflowResult(workflow_id, "failed", results, last_error)

        journal["status"] = "completed"
        journal["current_step"] = None
        return WorkflowResult(workflow_id, "completed", results)
