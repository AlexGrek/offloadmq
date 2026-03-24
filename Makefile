APP_NAME := offloadmq
CHART_DIR := offloadmq-chart
NAMESPACE := offloadmq
RELEASE := offloadmq
REGISTRY ?= grekodocker
# Detect Git version if TAG is not provided
TAG ?= $(shell git rev-list --count HEAD)
IMAGE ?= ${REGISTRY}/offloadmq
FRONTEND_IMAGE ?= ${REGISTRY}/offloadmq-management-frontend
SECRETS_FILE ?= .secrets.yaml

CONTAINER_RUNTIME := docker

DL_API_KEY  ?=
DL_BASE_URL ?= https://dl.alexgr.space

.PHONY: build build-multiplatform push install upgrade uninstall status template deploy deploy-multiplatform secrets secrets-force build-client rebuild-client build-frontend push-frontend clean-all rebuild-all pre-pull-images wait-for-image-pull release-agent

# Build container image (linux/amd64 only, pushed directly via buildx)
build:
	@echo "Building for linux/amd64..."
	docker buildx build \
		--platform linux/amd64 \
		--tag $(IMAGE):$(TAG) \
		--push \
		.

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

push:
	@true # build already pushes via buildx

# Generate .secrets.yaml file with random secrets (helm values format)
secrets:
	@echo "Generating $(SECRETS_FILE)..."
	@if [ -f $(SECRETS_FILE) ]; then \
		echo "WARNING: $(SECRETS_FILE) already exists. Remove it first or use 'make secrets-force'"; \
		exit 1; \
	fi
	@AGENT_KEY=$$(openssl rand -hex 32); \
	CLIENT_KEY=$$(openssl rand -hex 32); \
	JWT_SECRET=$$(openssl rand -hex 48); \
	MGMT_TOKEN=$$(openssl rand -hex 48); \
	printf 'secrets:\n  AGENT_API_KEYS: "%s"\n  CLIENT_API_KEYS: "%s"\n  JWT_SECRET: "%s"\n  MGMT_TOKEN: "%s"\n' \
		"$$AGENT_KEY" "$$CLIENT_KEY" "$$JWT_SECRET" "$$MGMT_TOKEN" > $(SECRETS_FILE)
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
		--set frontend.image.repository=$(FRONTEND_IMAGE) \
		--set frontend.image.tag=$(TAG) \
		--set appVersion=$(TAG) \
		-f $(SECRETS_FILE)

# Pre-pull container images on cluster nodes to reduce helm upgrade downtime
pre-pull-images:
	@echo "Pre-pulling images on cluster nodes..."
	helm template $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		--set frontend.image.repository=$(FRONTEND_IMAGE) \
		--set frontend.image.tag=$(TAG) \
		--set appVersion=$(TAG) \
		--set imagePullPolicy.preLoadImages=true \
		-f $(SECRETS_FILE) \
		| kubectl apply -f -
	@$(MAKE) wait-for-image-pull

# Wait for image pull job to complete (with proper cleanup handling)
wait-for-image-pull:
	@job_name="offloadmq-image-pull-$(TAG)"; \
	timeout=120; \
	elapsed=0; \
	while [ $$elapsed -lt $$timeout ]; do \
		sleep 5; \
		elapsed=$$((elapsed + 5)); \
		if kubectl wait --for=condition=Complete job/$$job_name -n $(NAMESPACE) --timeout=5s 2>/dev/null; then \
			echo "✓ Image pull job completed"; \
			kubectl delete job $$job_name -n $(NAMESPACE) --ignore-not-found=true 2>/dev/null; \
			exit 0; \
		fi; \
		if ! kubectl get job $$job_name -n $(NAMESPACE) >/dev/null 2>&1; then \
			echo "✓ Image pull job already completed and cleaned up"; \
			exit 0; \
		fi; \
		echo "Pulling images... ($$elapsed/$${timeout}s)"; \
	done; \
	echo "⚠ Image pull timeout ($$timeout exceeded), proceeding anyway"; \
	exit 0

# Upgrade Helm release
upgrade:
	helm upgrade $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		--set frontend.image.repository=$(FRONTEND_IMAGE) \
		--set frontend.image.tag=$(TAG) \
		--set appVersion=$(TAG) \
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
		--set frontend.image.repository=$(FRONTEND_IMAGE) \
		--set frontend.image.tag=$(TAG) \
		--set appVersion=$(TAG) \
		-f $(SECRETS_FILE)

# Build, push, and install/upgrade in one go
deploy: build push build-frontend push-frontend
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "ERROR: Secrets file '$(SECRETS_FILE)' not found!"; \
		exit 1; \
	fi
	@if helm status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Upgrading $(RELEASE) to $(IMAGE):$(TAG) ..."; \
		$(MAKE) pre-pull-images || exit 1; \
		$(MAKE) upgrade; \
	else \
		echo "Installing $(RELEASE) as $(IMAGE):$(TAG) ..."; \
		$(MAKE) install; \
	fi

# Build multiplatform, and install/upgrade in one go
deploy-multiplatform: build-multiplatform build-frontend push-frontend
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "ERROR: Secrets file '$(SECRETS_FILE)' not found!"; \
		exit 1; \
	fi
	@if helm status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Upgrading $(RELEASE) to $(IMAGE):$(TAG) ..."; \
		$(MAKE) pre-pull-images || exit 1; \
		$(MAKE) upgrade; \
	else \
		echo "Installing $(RELEASE) as $(IMAGE):$(TAG) ..."; \
		$(MAKE) install; \
	fi

# Build management frontend image (linux/amd64 only, pushed directly via buildx)
build-frontend:
	@echo "Building frontend for linux/amd64..."
	docker buildx build \
		--platform linux/amd64 \
		--tag $(FRONTEND_IMAGE):$(TAG) \
		--push \
		management-frontend/

push-frontend:
	@true # build-frontend already pushes via buildx

# Build the offload-agent standalone binary
build-client:
	cd offload-agent && make build

rebuild-client:
	cd offload-agent && make rebuild

# Build and upload offload-agent for the current platform to dl.alexgr.space
# Version is auto-detected from latest release-* tag + commit count (e.g. v0.3.260)
# Override: make release-agent VERSION=v0.3.260
# Requires: DL_API_KEY (set in ~/.zshrc or pass inline: make release-agent DL_API_KEY=dlk_...)
release-agent:
	@if [ -z "$(DL_API_KEY)" ]; then echo "error: DL_API_KEY is not set"; exit 1; fi
	DL_API_KEY=$(DL_API_KEY) DL_BASE_URL=$(DL_BASE_URL) ./scripts/release-agent.sh $(if $(VERSION),$(VERSION),)

# Clean all build artifacts across the whole repo
clean-all:
	@echo "Cleaning Rust artifacts..."
	cargo clean
	@echo "Cleaning offload-agent artifacts..."
	cd offload-agent && make clean
	@echo "Cleaning management-frontend dist..."
	rm -rf management-frontend/dist
	@echo "All clean."

# Clean everywhere, rebuild both images, push, and upgrade helm chart
rebuild-all: clean-all build build-frontend
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "ERROR: Secrets file '$(SECRETS_FILE)' not found!"; \
		exit 1; \
	fi
	@if helm status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Upgrading $(RELEASE) to $(IMAGE):$(TAG) ..."; \
		$(MAKE) pre-pull-images || exit 1; \
		$(MAKE) upgrade; \
	else \
		echo "Installing $(RELEASE) as $(IMAGE):$(TAG) ..."; \
		$(MAKE) install; \
	fi

dev-mq:
	cargo run

dev-agent:
	cd offload-agent && make serve

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
