package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func servingStatus(t *testing.T, status int, body string) func() {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Setenv("AKM_SERVICE_URL", srv.URL)
	t.Setenv("AKM_TOKEN", "test-token")
	return srv.Close
}

func TestReadPrintsContentToStdout(t *testing.T) {
	defer servingStatus(t, 200, `{"path":"notes/x.md","content":"hello world"}`)()

	stdout, err := captureStdout(t, func() error {
		return readCmd.RunE(readCmd, []string{"notes/x.md"})
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stdout != "hello world" {
		t.Errorf("expected raw content on stdout with no extra formatting; got: %q", stdout)
	}
}

// THE ASSERTION THAT MATTERS: a 200 whose "content" field is not a string
// (a shape change, a null, a nested object) must be an ERROR — the same
// defect family shape.go's own errUnexpectedShape was built to close for
// search/context, applied here. Printing nothing and exiting 0 would be
// indistinguishable from a genuinely empty entry.
func TestReadUnexpectedContentTypeIsAnError(t *testing.T) {
	defer servingStatus(t, 200, `{"path":"notes/x.md","content":42}`)()

	err := readCmd.RunE(readCmd, []string{"notes/x.md"})
	if err == nil {
		t.Fatal("expected an error for a non-string content field; got nil")
	}
	if !strings.Contains(err.Error(), "unexpected content type") {
		t.Errorf("error should name the problem; got: %v", err)
	}
}

func TestReadMissingEntryIsAnError(t *testing.T) {
	defer servingStatus(t, 404, `{"error":"not found"}`)()

	err := readCmd.RunE(readCmd, []string{"notes/missing.md"})
	if err == nil {
		t.Fatal("expected an error for a 404; got nil")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error should say the entry was not found; got: %v", err)
	}
}
