"""FastAPI implementation of the SAGE stateful Responses profile."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from contract import (
    ContractError,
    MAX_ERROR_BYTES,
    is_previous_response_error,
    validate_external_artifact_url,
    validate_platform_contract,
)
from state_store import (
    DurableResponseStreamGate,
    SqliteResponseStateStore,
    commit_then_release_terminal,
)

MAX_BODY_BYTES = 256_000
MAX_UPSTREAM_BYTES = 8_000_000
UPSTREAM_TOTAL_TIMEOUT_SECONDS = 60
state = SqliteResponseStateStore()
state.prune()
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("sage-agent")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    state.close()


app = FastAPI(lifespan=lifespan)


def log(event: str, **fields: object) -> None:
    logger.info(
        json.dumps(
            {
                "event": event,
                "level": "info",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                **fields,
            },
            separators=(",", ":"),
        )
    )


def required(name: str, minimum: int = 1) -> str:
    value = os.environ.get(name, "").strip()
    if not value or len(value) < minimum or "replace-with" in value:
        raise RuntimeError(f"missing or invalid required environment variable: {name}")
    return value


def authenticated(request: Request) -> bool:
    supplied = request.headers.get("authorization", "")
    expected = f"Bearer {required('AGENT_INVOCATION_KEY', 32)}"
    return hmac.compare_digest(supplied.encode(), expected.encode())


def artifact_event() -> bytes:
    raw = os.environ.get("AGENT_ARTIFACT_URL", "").strip()
    if not raw:
        return b""
    validate_external_artifact_url(raw)
    event = {"type": "sage.artifact.link", "url": raw, "name": "agent-output"}
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n".encode()


def continuation_lost() -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "error": {
                "code": "previous_response_not_found",
                "message": "The Agent cannot continue from that response ID.",
            }
        },
    )


async def read_bounded_error(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    transferred = 0
    async for chunk in response.aiter_raw():
        transferred += len(chunk)
        if transferred > MAX_ERROR_BYTES:
            raise RuntimeError("upstream error response too large")
        chunks.append(chunk)
    return b"".join(chunks)


@app.middleware("http")
async def request_log(request: Request, call_next):
    started = time.monotonic()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        log(
            "request_finished",
            duration_ms=round((time.monotonic() - started) * 1000),
            method=request.method,
            route=request.url.path,
            status=status,
        )


@app.get("/healthz", status_code=204)
async def health() -> Response:
    return Response(status_code=204, headers={"cache-control": "no-store"})


@app.get("/readyz", status_code=204)
async def readiness() -> Response:
    try:
        required("AGENT_INVOCATION_KEY", 32)
        required("AGENT_MODEL")
        required("SAGE_PLATFORM_ORIGIN")
        if not state.ready():
            raise RuntimeError("state store unavailable")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="agent unavailable") from exc
    return Response(status_code=204, headers={"cache-control": "no-store"})


@app.post("/v1/responses", response_model=None)
async def responses(request: Request) -> StreamingResponse | JSONResponse:
    if not authenticated(request):
        raise HTTPException(status_code=401, detail="unauthorized")
    try:
        declared = int(request.headers.get("content-length", "0") or "0")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid content length") from exc
    if declared < 0:
        raise HTTPException(status_code=400, detail="invalid content length")
    if declared > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="request too large")
    chunks: list[bytes] = []
    transferred = 0
    async for chunk in request.stream():
        transferred += len(chunk)
        if transferred > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="request too large")
        chunks.append(chunk)
    raw = b"".join(chunks)
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid JSON") from exc
    try:
        (
            items,
            previous_response_id,
            model_proxy_base_url,
            model_proxy_token,
            conversation_id,
        ) = validate_platform_contract(
            request.headers, body, required("SAGE_PLATFORM_ORIGIN")
        )
    except ContractError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    provider_previous = None
    if previous_response_id is not None:
        provider_previous = state.resolve(conversation_id, previous_response_id)
        if provider_previous is None:
            return continuation_lost()

    headers = {
        "authorization": f"Bearer {model_proxy_token}",
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    payload: dict[str, object] = {
        "model": required("AGENT_MODEL"),
        "input": items,
        "stream": True,
    }
    if provider_previous:
        payload["previous_response_id"] = provider_previous
    target = f"{model_proxy_base_url}/responses"
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(60, connect=5), follow_redirects=False
    )
    try:
        upstream = await client.send(
            client.build_request("POST", target, headers=headers, json=payload),
            stream=True,
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail="model gateway unavailable") from exc
    if upstream.status_code < 200 or upstream.status_code >= 300:
        try:
            raw_error = await read_bounded_error(upstream)
        except RuntimeError as exc:
            await upstream.aclose()
            await client.aclose()
            raise HTTPException(
                status_code=502, detail="model gateway returned an invalid error"
            ) from exc
        normalized = is_previous_response_error(
            upstream.status_code, raw_error, provider_previous is not None
        )
        await upstream.aclose()
        await client.aclose()
        if normalized:
            return continuation_lost()
        raise HTTPException(status_code=502, detail="model gateway rejected the request")
    if not upstream.headers.get("content-type", "").startswith("text/event-stream"):
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(
            status_code=502, detail="model gateway returned an invalid stream"
        )

    async def relay() -> AsyncIterator[bytes]:
        transferred = 0
        gate = DurableResponseStreamGate()
        try:
            artifact = artifact_event()
            if artifact:
                yield artifact
            async with asyncio.timeout(UPSTREAM_TOTAL_TIMEOUT_SECONDS):
                async for chunk in upstream.aiter_raw():
                    transferred += len(chunk)
                    if transferred > MAX_UPSTREAM_BYTES:
                        raise RuntimeError("upstream response too large")
                    for frame in gate.push(chunk):
                        yield frame
            completion = gate.finish()
            for frame in completion.output_frames:
                yield frame
            for frame in commit_then_release_terminal(
                completion=completion,
                conversation_id=conversation_id,
                state=state,
            ):
                yield frame
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={"cache-control": "no-store"},
    )
