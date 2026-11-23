#!/usr/bin/env python3
"""
Supervised JSON-RPC 2.0 stdio sidecar for Google Antigravity Python SDK and CLI.
Uses `google.antigravity` when installed, or reports SDK/CLI diagnostics honestly.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys

HAS_SDK = False
try:
    from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig  # type: ignore
    HAS_SDK = True
except ImportError:
    HAS_SDK = False


async def handle_request(req: dict) -> dict:
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}

    if method == "status":
        agy_bin = shutil.which(os.environ.get("ANTIGRAVITY_BIN", "agy")) or "/home/codespace/.local/bin/agy"
        cli_installed = os.path.exists(agy_bin)
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sdk_available": HAS_SDK,
                "cli_installed": cli_installed,
                "cli_path": agy_bin if cli_installed else None,
            },
        }

    if method == "chat":
        prompt = params.get("prompt", "")
        system_instructions = params.get("system_instructions", "")
        read_only = bool(params.get("read_only", True))

        if HAS_SDK:
            config = (
                LocalAgentConfig(system_instructions=system_instructions)
                if read_only
                else LocalAgentConfig(
                    system_instructions=system_instructions,
                    capabilities=CapabilitiesConfig(),
                )
            )
            tokens = []
            thoughts = []
            tool_calls = []
            async with Agent(config) as agent:
                response = await agent.chat(prompt)
                async for token in response:
                    tokens.append(str(token))
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "engine": "python-sdk",
                    "text": "".join(tokens),
                    "thoughts": thoughts,
                    "tool_calls": tool_calls,
                },
            }
        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32001,
                    "message": "google-antigravity Python SDK is not installed in this Python environment; use agy CLI transport.",
                },
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


async def main() -> None:
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = await handle_request(req)
        except Exception as exc:
            resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": str(exc)},
            }
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
