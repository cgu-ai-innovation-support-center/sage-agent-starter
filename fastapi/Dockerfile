FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ENV HOST=0.0.0.0 \
    PORT=8080 \
    AGENT_STATE_DB=/data/agent-state.sqlite \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY fastapi/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && addgroup --system --gid 10001 sage \
    && adduser --system --uid 10001 --ingroup sage --home /nonexistent --no-create-home sage \
    && install -d -o sage -g sage -m 0700 /data
COPY --chown=sage:sage fastapi/ ./fastapi/

USER sage
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/readyz', timeout=2)"]
CMD ["uvicorn", "--app-dir", "fastapi", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]
