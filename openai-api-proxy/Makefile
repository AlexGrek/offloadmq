VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip

.PHONY: venv serve test clean

venv: $(VENV)/bin/activate

$(VENV)/bin/activate: requirements.txt
	python3 -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt
	touch $(VENV)/bin/activate

serve: venv
	$(PYTHON) proxy.py

test: venv
	$(PYTHON) -m pytest test_proxy.py -v

clean:
	rm -rf $(VENV)
