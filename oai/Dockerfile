# syntax=docker/dockerfile:1.7
# Build context: oai/ directory (the monorepo sub-project root).
# Frontend must be built on the host before running docker build (frontend/dist/ is copied in).
ARG TARGETPLATFORM=linux/amd64
FROM --platform=$TARGETPLATFORM rust:1.91-slim-bookworm AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN --mount=type=cache,id=oai-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=oai-cargo-git,target=/usr/local/cargo/git \
    cargo fetch --locked
COPY backend/ ./
RUN --mount=type=cache,id=oai-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=oai-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=oai-rust-target,target=/app/.target-cache \
    CARGO_TARGET_DIR=/app/.target-cache cargo build --release --locked && \
    cp /app/.target-cache/release/oai-backend /app/oai-backend

FROM --platform=$TARGETPLATFORM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/oai-backend ./oai-backend
COPY frontend/dist/ ./static/

EXPOSE 3000
ENV SERVER_ADDRESS=0.0.0.0:3000
ENV STATIC_DIR=/app/static
ENV RUST_LOG=info

CMD ["./oai-backend"]
