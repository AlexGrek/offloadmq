SERVER ?= http://localhost:3069
KEY ?= ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e

# Version injected at build time (can be overridden)
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")

venv:
	python3 -m venv venv
	bash -c "source venv/bin/activate && pip3 install -r requirements.txt"

# Production web UI bundle (required for packaged agent and make webui)
frontend-build:
	cd frontend && npm ci && npm run build

register: venv
	bash -c "source venv/bin/activate && python offload-agent.py cli register --server $(SERVER) --key $(KEY)"

serve: register
	bash -c "source venv/bin/activate && python offload-agent.py cli serve"

sysinfo: venv
	bash -c "source venv/bin/activate && python offload-agent.py cli sysinfo"

ollama: venv
	bash -c "source venv/bin/activate && python offload-agent.py cli ollama"

# Standalone binary: rebuilds frontend then PyInstaller
build: venv frontend-build
	@echo "Installing PyInstaller..."
	bash -c "source venv/bin/activate && pip install pyinstaller --quiet"
	@echo "Building binary with PyInstaller (version: $(VERSION))..."
	bash -c "source venv/bin/activate && OFFLOAD_AGENT_VERSION='$(VERSION)' python -m PyInstaller --onefile --name offload-agent \
		--add-data 'app:app' \
		--add-data 'webui.py:.' \
		--add-data 'frontend/dist:frontend/dist' \
		offload-agent.py"
	@echo ""
	@echo "Build complete. The binary is located in the 'dist' directory."

rebuild: clean build

clean:
	@echo "Cleaning up build artifacts..."
	rm -rf build/ dist/ offload-agent.spec
	@echo "Cleanup complete."

webui: venv frontend-build
	bash -c "source venv/bin/activate && python offload-agent.py webui"

.PHONY: sysinfo register ollama build rebuild clean webui frontend-build
