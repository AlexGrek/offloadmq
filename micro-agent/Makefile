BIN = micro-agent

.PHONY: build build-linux build-darwin-amd64 build-darwin-arm64 build-windows build-all clean run deps

build: deps
	go build -o $(BIN) .

build-linux: deps
	GOOS=linux GOARCH=amd64 go build -o $(BIN)-linux-amd64 .

build-darwin-amd64: deps
	GOOS=darwin GOARCH=amd64 go build -o $(BIN)-darwin-amd64 .

build-darwin-arm64: deps
	GOOS=darwin GOARCH=arm64 go build -o $(BIN)-darwin-arm64 .

build-windows: deps
	GOOS=windows GOARCH=amd64 go build -o $(BIN)-windows-amd64.exe .

build-all: build-linux build-darwin-amd64 build-darwin-arm64 build-windows

deps:
	go mod tidy

run: build
	./$(BIN)

clean:
	rm -f $(BIN) $(BIN)-linux-amd64 $(BIN)-darwin-amd64 $(BIN)-darwin-arm64 $(BIN)-windows-amd64.exe
