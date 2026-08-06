package cmd

import (
	"strings"
	"testing"
)

func TestJournalRejectsEmptyStdin(t *testing.T) {
	// No server needed — this must fail before any request is sent. Env
	// vars are still required for client.NewFromEnv() to construct at all
	// (that happens before the stdin check); a bogus, never-dialed URL
	// proves this, since a real request would fail differently.
	t.Setenv("AKM_SERVICE_URL", "http://127.0.0.1:1")
	t.Setenv("AKM_TOKEN", "test-token")
	withStdin(t, "   \n\t\n")

	err := journalCmd.RunE(journalCmd, nil)
	if err == nil {
		t.Fatal("expected an error for whitespace-only stdin; got nil")
	}
	if !strings.Contains(err.Error(), "no content provided") {
		t.Errorf("error should say why; got: %v", err)
	}
}

func TestJournalAppendsAndPrintsPath(t *testing.T) {
	captured, _ := servingCapturingBody(t, 201, `{"path":"journal/2026-08-06.md","id":"j1"}`)
	withStdin(t, "  did the thing today  \n")

	stdout, err := captureStdout(t, func() error {
		return journalCmd.RunE(journalCmd, nil)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stdout, "appended to: journal/2026-08-06.md") {
		t.Errorf("expected an appended-to confirmation naming the real path; got: %s", stdout)
	}
	// THE ASSERTION THAT MATTERS: the trim happens before the request is
	// sent, not just before the emptiness check — leading/trailing
	// whitespace must not ride along into the stored entry.
	if *captured != "did the thing today" {
		t.Errorf("expected trimmed content sent to the server; got: %q", *captured)
	}
}
