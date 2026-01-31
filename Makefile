APP_NAME := offloadmq
CHART_DIR := offloadmq-chart
NAMESPACE := offloadmq
RELEASE := offloadmq
REGISTRY ?= localhost:5000
# Detect Git version if TAG is not provided
TAG ?= $(shell git describe --tags --always --dirty)
IMAGE ?= ${REGISTRY}/offloadmq
SECRETS_FILE ?= .secrets.yaml

# Detect container runtime: prefer podman, fallback to docker
CONTAINER_RUNTIME := $(shell command -v podman 2>/dev/null)
ifndef CONTAINER_RUNTIME
    CONTAINER_RUNTIME := $(shell command -v docker 2>/dev/null)
endif
ifndef CONTAINER_RUNTIME
    $(error Neither podman nor docker found in PATH. Please install one of them.)
endif

.PHONY: build build-multiplatform push install upgrade uninstall status template deploy deploy-multiplatform secrets secrets-force

# Build container image
build:
	@echo "Building with $(CONTAINER_RUNTIME)..."
	$(CONTAINER_RUNTIME) build -t $(IMAGE):$(TAG) .

# Build multiplatform image with buildx (amd64 and arm64)
# Set PLATFORMS to override (e.g., make build-multiplatform PLATFORMS=linux/amd64,linux/arm64,linux/arm/v7)
PLATFORMS ?= linux/amd64,linux/arm64
build-multiplatform:
	@echo "Building multiplatform image for $(PLATFORMS)..."
	docker buildx build \
		--platform $(PLATFORMS) \
		--tag $(IMAGE):$(TAG) \
		--push \
		.

# Push container image
push:
	@echo "Pushing with $(CONTAINER_RUNTIME)..."
	$(CONTAINER_RUNTIME) push $(IMAGE):$(TAG)

# Generate .secrets.yaml file with random secrets
secrets:
	@echo "Generating $(SECRETS_FILE)..."
	@if [ -f $(SECRETS_FILE) ]; then \
		echo "WARNING: $(SECRETS_FILE) already exists. Remove it first or use 'make secrets-force'"; \
		exit 1; \
	fi
	@AGENT_KEY=$$(openssl rand -base64 24 | tr -d '\n' | base64 | tr -d '\n'); \
	CLIENT_KEY=$$(openssl rand -base64 24 | tr -d '\n' | base64 | tr -d '\n'); \
	JWT_SECRET=$$(openssl rand -base64 48 | tr -d '\n' | base64 | tr -d '\n'); \
	MGMT_TOKEN=$$(openssl rand -base64 48 | tr -d '\n' | base64 | tr -d '\n'); \
	cat > $(SECRETS_FILE) <<EOF ;\
apiVersion: v1\n\
kind: Secret\n\
metadata:\n\
  name: offloadmq-secrets\n\
  namespace: $(NAMESPACE)\n\
data:\n\
  AGENT_API_KEYS: $$AGENT_KEY\n\
  CLIENT_API_KEYS: $$CLIENT_KEY\n\
  JWT_SECRET: $$JWT_SECRET\n\
  MGMT_TOKEN: $$MGMT_TOKEN\n\
type: Opaque\n\
EOF
	@echo "✓ Generated $(SECRETS_FILE) with random secrets"

# Force regenerate secrets (overwrites existing file)
secrets-force:
	@rm -f $(SECRETS_FILE)
	@$(MAKE) secrets

# Install Helm chart
install:
	helm install $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) --create-namespace \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		-f $(SECRETS_FILE)

# Upgrade Helm release
upgrade:
	helm upgrade $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		-f $(SECRETS_FILE)

# Uninstall release
uninstall:
	helm uninstall $(RELEASE) --namespace $(NAMESPACE)

# Show release status
status:
	helm status $(RELEASE) --namespace $(NAMESPACE)

# Render manifests without installing
template:
	helm template $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		-f $(SECRETS_FILE)

# Build, push, and install/upgrade in one go
deploy: build push
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "ERROR: Secrets file '$(SECRETS_FILE)' not found!"; \
		exit 1; \
	fi
	@if helm status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Upgrading $(RELEASE) to $(IMAGE):$(TAG) ..."; \
		$(MAKE) upgrade; \
	else \
		echo "Installing $(RELEASE) as $(IMAGE):$(TAG) ..."; \
		$(MAKE) install; \
	fi

# Build multiplatform, and install/upgrade in one go
deploy-multiplatform: build-multiplatform
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "ERROR: Secrets file '$(SECRETS_FILE)' not found!"; \
		exit 1; \
	fi
	@if helm status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Upgrading $(RELEASE) to $(IMAGE):$(TAG) ..."; \
		$(MAKE) upgrade; \
	else \
		echo "Installing $(RELEASE) as $(IMAGE):$(TAG) ..."; \
		$(MAKE) install; \
	fi

dev-mq:
	cargo run

dev-agent:
	cd offload-client && make serve

dev-frontend:
	cd management-frontend && npm run dev

# Run Rust unit tests
test-unit:
	cargo test

# Run integration tests (requires server and agent already running)
test:
	cd itests && make run

# Run full integration tests (starts server + agent, runs tests, stops everything)
test-full:
	cd itests && make test-full

# Start server and agent for manual testing
test-start:
	cd itests && make start-agent

# Stop server and agent
test-stop:
	cd itests && make stop-all

# Show test infrastructure logs
test-logs:
	cd itests && make logs
