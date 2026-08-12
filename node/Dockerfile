FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

ARG SAGE_AGENT_SOURCE_REVISION
RUN case "${SAGE_AGENT_SOURCE_REVISION}" in \
      ""|0000000000000000000000000000000000000000|*[!0-9a-f]*) exit 1 ;; \
    esac \
    && [ "${#SAGE_AGENT_SOURCE_REVISION}" -eq 40 ]
LABEL org.opencontainers.image.revision="${SAGE_AGENT_SOURCE_REVISION}"

ENV HOST=0.0.0.0 \
    PORT=8080 \
    AGENT_STATE_DB=/data/agent-state.sqlite \
    NODE_ENV=production

WORKDIR /app
COPY --chown=node:node agent/ ./agent/
COPY --chown=node:node node/ ./node/
RUN install -d -o node -g node -m 0700 /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "node/server.mjs"]
