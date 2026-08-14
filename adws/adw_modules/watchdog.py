"""Stall watchdog for coding-agent subprocesses.

Every backend tails its child's stdout with a blocking line loop. A child
that goes quiet — a wedged CLI, a network call that never returns, a stderr
pipe deadlock — turns that loop into an infinite wait nothing in the run can
interrupt: the ADW sits at 0% CPU forever and the chain never finishes.

This module is the guard. It yields stdout lines through a reader thread;
if no line arrives within the stall window it kills the child and raises
StallTimeout, which fails the phase with a message that names the silence.

The window measures SILENCE, not total runtime. A long turn that keeps
emitting events never trips it — a hard runtime cap would kill legitimately
slow work, so there deliberately isn't one.
"""

from __future__ import annotations

import queue
import subprocess
import threading
from typing import Iterator

_EOF = object()


class StallTimeout(RuntimeError):
    """The child emitted nothing for the whole stall window and was killed."""


def stream_lines(process: subprocess.Popen, stall_timeout_seconds: int,
                 label: str = "agent") -> Iterator[str]:
    """Yield lines from process.stdout, killing the child if it goes silent.

    A window of 0 (or less) disables the watchdog and iterates plainly.
    """
    assert process.stdout is not None
    if stall_timeout_seconds <= 0:
        yield from process.stdout
        return

    lines: queue.Queue = queue.Queue()

    def _read() -> None:
        try:
            for line in process.stdout:
                lines.put(line)
        finally:
            lines.put(_EOF)

    # Daemon: after a kill the thread unblocks on EOF by itself, but it must
    # never be the thing keeping a dying interpreter alive.
    threading.Thread(target=_read, name=f"watchdog-{label}", daemon=True).start()

    while True:
        try:
            item = lines.get(timeout=stall_timeout_seconds)
        except queue.Empty:
            process.kill()
            process.wait()
            raise StallTimeout(
                f"{label}: no output for {stall_timeout_seconds}s — "
                f"killed pid {process.pid}") from None
        if item is _EOF:
            return
        yield item
