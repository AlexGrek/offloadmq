# ---- Frontend build stage ----
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Runtime stage ----
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV PDM_CHECK_UPDATE=false
COPY pyproject.toml pdm.lock ./
RUN pip install --no-cache-dir pdm && pdm sync --prod --no-editable --no-self

COPY . .
COPY --from=frontend-build /app/dist ./frontend/dist

ENV SERVER=http://offloadmq:3069
ENV AGENT_KEY=ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e
ENV WEBUI_PORT=8081

EXPOSE 8081

CMD pdm run python offload-agent.py cli register --server "$SERVER" --key "$AGENT_KEY" && \
    pdm run python offload-agent.py webui --host 0.0.0.0 --port "$WEBUI_PORT" --agent-autostart
