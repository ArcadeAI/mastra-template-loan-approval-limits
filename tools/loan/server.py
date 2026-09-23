#!/usr/bin/env python3
"""Entrypoint for `arcade deploy` and for running the toolkit locally.

`arcade deploy` starts this file to read the server's name and version off its
`initialize` response, then ships the package. It sets the transport, host and
port through `ARCADE_SERVER_*` environment variables, which `MCPApp.run` reads
when no argument overrides them — so this must stay argument-free.

Locally:

    uv run server.py            # stdio
    uv run server.py http       # Streamable HTTP on 127.0.0.1:8000
"""

import sys

from loan import app

if __name__ == "__main__":
    if len(sys.argv) > 1:
        app.run(transport=sys.argv[1])
    else:
        app.run()
