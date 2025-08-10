# ---- Build stage ----
FROM rust:1.87 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

# ---- Runtime stage ----
FROM debian:bookworm-slim
WORKDIR /app
# Install only needed runtime deps for Rust binaries
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/offloadmq /app/offloadmq

# Expose the app port (matches SERVER_ADDRESS in .env)
EXPOSE 3069

# Entrypoint
ENTRYPOINT ["/app/offloadmq"]
