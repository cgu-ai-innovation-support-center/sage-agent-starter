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

from agent_profile import load_agent_profile

from contract import (
    ContractError,
    MAX_ERROR_BYTES,
    is_previous_response_error,
    validate_external_artifact_url,
    validate_platform_contract,
    validate_platform_origin,
)
from state_store import (
    DurableResponseStreamGate,
    SqliteResponseStateStore,
    commit_then_release_terminal,
)
from provider_request import build_provider_request
from approval_demo import (
    approval_demo_pending_action,
    approval_demo_request_frames,
    approval_demo_result_frames,
    approval_request_id,
    approval_result_response_id,
    is_approval_demo_input,
)

MAX_BODY_BYTES = 256_000
MAX_UPSTREAM_BYTES = 8_000_000
REQUEST_BODY_TIMEOUT_SECONDS = 10
UPSTREAM_TOTAL_TIMEOUT_SECONDS = 60
state = SqliteResponseStateStore()
state.prune()
agent_profile = load_agent_profile()
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
        validate_platform_origin(required("SAGE_PLATFORM_ORIGIN"))
        configured_artifact_url = os.environ.get("AGENT_ARTIFACT_URL", "").strip()
        if configured_artifact_url:
            validate_external_artifact_url(configured_artifact_url)
        if not state.ready():
            raise RuntimeError("state store unavailable")
    except (ContractError, RuntimeError, ValueError) as exc:
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
    try:
        async with asyncio.timeout(REQUEST_BODY_TIMEOUT_SECONDS):
            async for chunk in request.stream():
                transferred += len(chunk)
                if transferred > MAX_BODY_BYTES:
                    raise HTTPException(status_code=413, detail="request too large")
                chunks.append(chunk)
    except TimeoutError as exc:
        raise HTTPException(status_code=408, detail="request body timeout") from exc
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

    approval_continuation = all(
        isinstance(item, dict) and item.get("type") == "mcp_approval_response"
        for item in items
    )
    if approval_continuation:
        typed_responses = [item for item in items if isinstance(item, dict)]
        result_response_id = approval_result_response_id(
            required("AGENT_INVOCATION_KEY", 32),
            conversation_id,
            previous_response_id or "",
            typed_responses,
        )
        consumed = state.consume_pending(
            conversation_id=conversation_id,
            response_id=previous_response_id or "",
            responses=typed_responses,
            result_response_id=result_response_id,
        )
        if consumed is None:
            return continuation_lost()

        async def approval_relay() -> AsyncIterator[bytes]:
            for frame in approval_demo_result_frames(
                consumed["actions"], result_response_id
            ):
                yield frame

        return StreamingResponse(
            approval_relay(),
            media_type="text/event-stream",
            headers={"cache-control": "no-store"},
        )

    approval_demo = is_approval_demo_input(items)

    provider_previous = None
    if previous_response_id is not None:
        if state.has_pending(conversation_id, previous_response_id):
            return continuation_lost()
        provider_previous = state.resolve(conversation_id, previous_response_id)
        if provider_previous is None:
            return continuation_lost()

    headers = {
        "authorization": f"Bearer {model_proxy_token}",
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    payload = build_provider_request(
        model=required("AGENT_MODEL"),
        instructions=agent_profile["instructions"],
        input_items=items,
        previous_response_id=provider_previous,
    )
    target = f"{model_proxy_base_url}/responses"
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(60, connect=5), follow_redirects=False
    )
    upstream_deadline = (
        asyncio.get_running_loop().time() + UPSTREAM_TOTAL_TIMEOUT_SECONDS
    )
    try:
        async with asyncio.timeout_at(upstream_deadline):
            upstream = await client.send(
                client.build_request("POST", target, headers=headers, json=payload),
                stream=True,
            )
    except (TimeoutError, httpx.HTTPError) as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail="model gateway unavailable") from exc
    if upstream.status_code < 200 or upstream.status_code >= 300:
        try:
            async with asyncio.timeout_at(upstream_deadline):
                raw_error = await read_bounded_error(upstream)
        except (RuntimeError, TimeoutError) as exc:
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
        relay_started = time.monotonic()
        outcome = "incomplete"
        transferred = 0
        gate = DurableResponseStreamGate()
        try:
            artifact = artifact_event()
            if artifact:
                yield artifact
            async with asyncio.timeout_at(upstream_deadline):
                async for chunk in upstream.aiter_raw():
                    transferred += len(chunk)
                    if transferred > MAX_UPSTREAM_BYTES:
                        raise RuntimeError("upstream response too large")
                    for frame in gate.push(chunk):
                        yield frame
            completion = gate.finish()
            outcome = completion.stream_outcome
            for frame in completion.output_frames:
                yield frame
            if approval_demo and completion.completed_response_id is not None:
                action = approval_demo_pending_action(
                    approval_request_id(
                        required("AGENT_INVOCATION_KEY", 32),
                        conversation_id,
                        completion.completed_response_id,
                    )
                )
                state.record_pending(
                    actions=[action],
                    conversation_id=conversation_id,
                    provider_response_id=completion.completed_response_id,
                )
                for frame in approval_demo_request_frames(action):
                    yield frame
                for frame in completion.terminal_frames:
                    yield frame
            else:
                for frame in commit_then_release_terminal(
                    completion=completion,
                    conversation_id=conversation_id,
                    state=state,
                ):
                    yield frame
        except BaseException:
            outcome = "failed"
            raise
        finally:
            await upstream.aclose()
            await client.aclose()
            log(
                "response_stream_finished",
                duration_ms=round((time.monotonic() - relay_started) * 1000),
                outcome=outcome,
            )

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={"cache-control": "no-store"},
    )
