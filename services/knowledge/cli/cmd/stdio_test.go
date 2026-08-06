package cmd

import (
	"io"
	"os"
	"testing"
)

// captureStdout mirrors partial_test.go's captureStderr for commands that
// write their real output (not just a summary) to stdout — read.go prints
// entry content there, and write.go/journal.go print a one-line confirmation.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("could not create pipe: %v", err)
	}
	os.Stdout = w

	runErr := fn()

	_ = w.Close()
	os.Stdout = orig
	out, readErr := io.ReadAll(r)
	if readErr != nil {
		t.Fatalf("could not read captured stdout: %v", readErr)
	}
	return string(out), runErr
}

// withStdin redirects os.Stdin to a pipe pre-loaded with content, for
// write.go and journal.go, both of which read the entry body via
// io.ReadAll(os.Stdin) rather than a flag or argument.
func withStdin(t *testing.T, content string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("could not create pipe: %v", err)
	}
	if _, err := w.WriteString(content); err != nil {
		t.Fatalf("could not write stdin fixture: %v", err)
	}
	_ = w.Close()

	orig := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = orig })
}
