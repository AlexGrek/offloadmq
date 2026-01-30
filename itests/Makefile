VENV := venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
PYTEST := $(VENV)/bin/pytest

# Paths relative to itests directory
ROOT_DIR := $(shell cd .. && pwd)
AGENT_DIR := $(ROOT_DIR)/offload-client
SERVER_PID_FILE := /tmp/offloadmq-server.pid
AGENT_PID_FILE := /tmp/offloadmq-agent.pid

ifeq ($(OS),Windows_NT)
	PYTHON := $(VENV)/Scripts/python
	PIP := $(VENV)/Scripts/pip
	PYTEST := $(VENV)/Scripts/pytest
endif

.PHONY: venv run clean start-server stop-server start-agent stop-agent test-full stop-all logs

venv:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt

# Run tests (assumes server and agent are already running)
run: venv
	$(PYTEST) -v

# Start the MQ server in background
start-server:
	@echo "Starting OffloadMQ server..."
	@if [ -f $(SERVER_PID_FILE) ] && kill -0 $$(cat $(SERVER_PID_FILE)) 2>/dev/null; then \
		echo "Server already running (PID $$(cat $(SERVER_PID_FILE)))"; \
	else \
		cd $(ROOT_DIR) && cargo run > /tmp/offloadmq-server.log 2>&1 & echo $$! > $(SERVER_PID_FILE); \
		echo "Waiting for server to be ready..."; \
		for i in 1 2 3 4 5 6 7 8 9 10; do \
			if curl -s http://localhost:3069/health > /dev/null 2>&1; then \
				echo "Server is ready (PID $$(cat $(SERVER_PID_FILE)))"; \
				break; \
			fi; \
			sleep 1; \
		done; \
		if ! curl -s http://localhost:3069/health > /dev/null 2>&1; then \
			echo "ERROR: Server failed to start. Check /tmp/offloadmq-server.log"; \
			exit 1; \
		fi; \
	fi

# Stop the MQ server
stop-server:
	@echo "Stopping OffloadMQ server..."
	@if [ -f $(SERVER_PID_FILE) ]; then \
		kill $$(cat $(SERVER_PID_FILE)) 2>/dev/null || true; \
		rm -f $(SERVER_PID_FILE); \
		echo "Server stopped"; \
	else \
		echo "No server PID file found"; \
	fi

# Start the agent in background (registers first if needed)
start-agent: start-server
	@echo "Starting OffloadMQ agent..."
	@if [ -f $(AGENT_PID_FILE) ] && kill -0 $$(cat $(AGENT_PID_FILE)) 2>/dev/null; then \
		echo "Agent already running (PID $$(cat $(AGENT_PID_FILE)))"; \
	else \
		cd $(AGENT_DIR) && . venv/bin/activate && \
		python offload-client.py register --caps shell.bash --caps debug.echo > /tmp/offloadmq-agent.log 2>&1 && \
		python offload-client.py serve >> /tmp/offloadmq-agent.log 2>&1 & echo $$! > $(AGENT_PID_FILE); \
		sleep 3; \
		if kill -0 $$(cat $(AGENT_PID_FILE)) 2>/dev/null; then \
			echo "Agent is ready (PID $$(cat $(AGENT_PID_FILE)))"; \
		else \
			echo "ERROR: Agent failed to start. Check /tmp/offloadmq-agent.log"; \
			exit 1; \
		fi; \
	fi

# Stop the agent
stop-agent:
	@echo "Stopping OffloadMQ agent..."
	@if [ -f $(AGENT_PID_FILE) ]; then \
		kill $$(cat $(AGENT_PID_FILE)) 2>/dev/null || true; \
		rm -f $(AGENT_PID_FILE); \
		echo "Agent stopped"; \
	else \
		echo "No agent PID file found"; \
	fi

# Full integration test: start everything, run tests, stop everything
test-full: venv start-server start-agent
	@echo "Running integration tests..."
	$(PYTEST) -v tests/; \
	TEST_EXIT=$$?; \
	$(MAKE) stop-agent; \
	$(MAKE) stop-server; \
	exit $$TEST_EXIT

# Stop all background processes
stop-all: stop-agent stop-server

# Show logs from server and agent
logs:
	@echo "=== Server Log ===" && tail -50 /tmp/offloadmq-server.log 2>/dev/null || echo "No server log"
	@echo ""
	@echo "=== Agent Log ===" && tail -50 /tmp/offloadmq-agent.log 2>/dev/null || echo "No agent log"

clean:
	rm -rf $(VENV)
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
