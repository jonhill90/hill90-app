package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// servingCapturingBody is like shape_test.go's serving(), but for a POST
// command: it records the request body it received so a test can assert on
// what was actually SENT, not just what was printed back — write.go's
// frontmatter-auto-wrap conditional mutates the outgoing content before the
// server ever sees it, so the only way to prove it worked is to inspect the
// request.
func servingCapturingBody(t *testing.T, status int, responseBody string) (*string, func()) {
	t.Helper()
	var captured string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var body map[string]string
		_ = json.Unmarshal(data, &body)
		captured = body["content"]
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(responseBody))
	}))
	t.Setenv("AKM_SERVICE_URL", srv.URL)
	t.Setenv("AKM_TOKEN", "test-token")
	t.Cleanup(srv.Close)
	return &captured, srv.Close
}

func TestWriteRejectsEmptyStdin(t *testing.T) {
	// No server needed — this must fail before any request is sent. Env
	// vars are still required for client.NewFromEnv() to construct at all
	// (that happens before the stdin check); a bogus, never-dialed URL
	// proves this, since a real request would fail differently.
	t.Setenv("AKM_SERVICE_URL", "http://127.0.0.1:1")
	t.Setenv("AKM_TOKEN", "test-token")
	withStdin(t, "   \n\t\n")
	writeTitle = ""

	err := writeCmd.RunE(writeCmd, []string{"notes/x.md"})
	if err == nil {
		t.Fatal("expected an error for whitespace-only stdin; got nil")
	}
	if !strings.Contains(err.Error(), "no content provided") {
		t.Errorf("error should say why; got: %v", err)
	}
}

// THE ASSERTION THAT MATTERS for this file: content with no frontmatter,
// given a --title, is auto-wrapped with BOTH the title and a type inferred
// from the path — not just passed through unchanged.
func TestWriteAutoWrapsFrontmatterWhenTitleGiven(t *testing.T) {
	captured, _ := servingCapturingBody(t, 201, `{"path":"plans/rollout.md","id":"e1"}`)
	withStdin(t, "the plan body\n")
	writeTitle = "Rollout Plan"
	t.Cleanup(func() { writeTitle = "" })

	stdout, err := captureStdout(t, func() error {
		return writeCmd.RunE(writeCmd, []string{"plans/rollout.md"})
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"title: Rollout Plan", "type: plan", "the plan body"} {
		if !strings.Contains(*captured, want) {
			t.Errorf("wrapped content should contain %q; got: %s", want, *captured)
		}
	}
	if !strings.Contains(stdout, "created: plans/rollout.md") {
		t.Errorf("expected a created-entry confirmation; got: %s", stdout)
	}
}

// GUARD RAIL: content that already has its own frontmatter must not be
// double-wrapped — the leading "---" is the signal write.go checks for.
func TestWriteDoesNotDoubleWrapExistingFrontmatter(t *testing.T) {
	original := "---\ntitle: Already Set\ntype: note\n---\nbody\n"
	captured, _ := servingCapturingBody(t, 201, `{"path":"notes/x.md","id":"e2"}`)
	withStdin(t, original)
	writeTitle = "Ignored Title"
	t.Cleanup(func() { writeTitle = "" })

	_, err := captureStdout(t, func() error {
		return writeCmd.RunE(writeCmd, []string{"notes/x.md"})
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if *captured != original {
		t.Errorf("pre-formed frontmatter must pass through unchanged; got: %s", *captured)
	}
}

// inferType is the other half of the auto-wrap conditional — path prefixes
// map to entry types. One representative case per prefix, plus the
// unmatched fallback.
func TestInferType(t *testing.T) {
	cases := map[string]string{
		"plans/x.md":      "plan",
		"decisions/x.md":  "decision",
		"journal/x.md":    "journal",
		"research/x.md":   "research",
		"context.md":      "context",
		"random/other.md": "note",
	}
	for path, want := range cases {
		if got := inferType(path); got != want {
			t.Errorf("inferType(%q) = %q, want %q", path, got, want)
		}
	}
}
