VENV := venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
PYTEST := $(VENV)/bin/pytest

ifeq ($(OS),Windows_NT)
	PYTHON := $(VENV)/Scripts/python
	PIP := $(VENV)/Scripts/pip
	PYTEST := $(VENV)/Scripts/pytest
endif

.PHONY: venv run clean

venv:
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt

run: venv
	$(PYTEST) -v

clean:
	rm -rf $(VENV)
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
