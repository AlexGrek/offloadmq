package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

var stdin = bufio.NewReader(os.Stdin)

// readLine prints prompt to stderr and reads one line from stdin.
func readLine(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	line, err := stdin.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// readPassword reads a password without echo on a TTY, or a plain line from
// stdin when piped. OAI_PASSWORD takes precedence for non-interactive use.
func readPassword(prompt string) (string, error) {
	if p := os.Getenv("OAI_PASSWORD"); p != "" {
		return p, nil
	}
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, prompt)
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	return readLine(prompt)
}
