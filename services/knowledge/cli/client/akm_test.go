package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestCLIWriteAndRead(t *testing.T) {
	// Mock AKM server
	var createdPath string
	var createdContent string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify auth header
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			w.WriteHeader(401)
			w.Write([]byte(`{"detail":"authentication required"}`))
			return
		}

		switch {
		case r.Method == "POST" && r.URL.Path == "/api/v1/entries":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			createdPath = body["path"]
			createdContent = body["content"]
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":          "test-uuid",
				"path":        createdPath,
				"title":       "Test",
				"entry_type":  "note",
				"sync_status": "synced",
			})
		case r.Method == "GET" && r.URL.Path == "/api/v1/entries/notes/test.md":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":      "test-uuid",
				"path":    "notes/test.md",
				"title":   "Test",
				"content": createdContent,
			})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	c := &Client{
		BaseURL:    server.URL,
		Token:      "test-token",
		HTTPClient: server.Client(),
	}

	// Write
	content := "---\ntitle: Test\ntype: note\n---\nHello from Go."
	entry, err := c.CreateEntry("notes/test.md", content)
	if err != nil {
		t.Fatalf("CreateEntry failed: %v", err)
	}
	if entry["path"] != "notes/test.md" {
		t.Errorf("expected path notes/test.md, got %v", entry["path"])
	}

	// Read back
	readEntry, err := c.ReadEntry("notes/test.md")
	if err != nil {
		t.Fatalf("ReadEntry failed: %v", err)
	}
	if readEntry["content"] != content {
		t.Errorf("content mismatch: got %v", readEntry["content"])
	}
}

func TestCLIAuthFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"detail":"authentication required"}`))
	}))
	defer server.Close()

	c := &Client{
		BaseURL:    server.URL,
		Token:      "bad-token",
		HTTPClient: server.Client(),
	}

	_, err := c.ReadEntry("notes/test.md")
	if err == nil {
		t.Fatal("expected auth error, got nil")
	}
}

func TestCLIRefreshOnExpiry(t *testing.T) {
	callCount := 0
	newToken := "refreshed-token"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/internal/agents/refresh-token":
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(map[string]string{
				"token":          newToken,
				"refresh_secret": "new-secret",
			})
		case r.URL.Path == "/api/v1/entries/notes/test.md":
			callCount++
			auth := r.Header.Get("Authorization")
			if auth == "Bearer "+newToken {
				json.NewEncoder(w).Encode(map[string]interface{}{
					"id":      "test-uuid",
					"path":    "notes/test.md",
					"content": "refreshed content",
				})
			} else {
				w.WriteHeader(401)
				w.Write([]byte(`{"detail":"expired"}`))
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	// Set up refresh secret env var
	os.Setenv("AKM_REFRESH_SECRET", "test-refresh-secret")
	defer os.Unsetenv("AKM_REFRESH_SECRET")

	c := &Client{
		BaseURL:    server.URL,
		Token:      "expired-token",
		HTTPClient: server.Client(),
	}

	entry, err := c.ReadEntry("notes/test.md")
	if err != nil {
		t.Fatalf("ReadEntry with refresh failed: %v", err)
	}
	if entry["content"] != "refreshed content" {
		t.Errorf("expected refreshed content, got %v", entry["content"])
	}
	if c.Token != newToken {
		t.Errorf("expected token to be updated to %s, got %s", newToken, c.Token)
	}
}

func TestNewFromEnvMissingURL(t *testing.T) {
	os.Unsetenv("AKM_SERVICE_URL")
	os.Unsetenv("AKM_TOKEN")
	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("expected error when AKM_SERVICE_URL not set")
	}
}

func TestNewFromEnvMissingToken(t *testing.T) {
	os.Setenv("AKM_SERVICE_URL", "http://localhost:8002")
	defer os.Unsetenv("AKM_SERVICE_URL")
	os.Unsetenv("AKM_TOKEN")
	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("expected error when AKM_TOKEN not set")
	}
}

// TestListEntriesReadsTotalFromHeader is the positive control for the Go half
// of #180. The page length and the real total MUST disagree — two rows with
// X-Total-Count: 3 — because an implementation that returns len(Entries) as
// the total passes any fixture where they match. That implementation is the
// defect: it prints a number that agrees with itself and calls a truncated
// listing complete.
func TestListEntriesReadsTotalFromHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "2" {
			t.Errorf("limit not forwarded: %s", r.URL.RawQuery)
		}
		if r.URL.Query().Get("offset") != "4" {
			t.Errorf("offset not forwarded: %s", r.URL.RawQuery)
		}
		w.Header().Set("X-Total-Count", "3")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"path":"a.md"},{"path":"b.md"}]`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t", HTTPClient: srv.Client()}
	page, err := c.ListEntries("", 2, 4)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}

	if len(page.Entries) != 2 {
		t.Errorf("page length = %d, want 2", len(page.Entries))
	}
	if page.Total != 3 {
		t.Errorf("Total = %d, want 3 (the set, not the page)", page.Total)
	}
	if page.Total == len(page.Entries) {
		t.Error("Total equals the page length — the fixture cannot detect the defect")
	}
}

// An older server sends no header. Total must read as unknown (-1), never as
// len(Entries): "no total reported" and "this is the total" are different
// claims, and only the first is true.
func TestListEntriesUnknownTotalWhenHeaderAbsent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"path":"a.md"},{"path":"b.md"}]`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t", HTTPClient: srv.Client()}
	page, err := c.ListEntries("", 0, 0)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if page.Total != -1 {
		t.Errorf("Total = %d, want -1 (unknown)", page.Total)
	}
}

// A malformed header must not be believed.
func TestListEntriesIgnoresNonNumericTotal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Total-Count", "lots")
		_, _ = w.Write([]byte(`[{"path":"a.md"}]`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t", HTTPClient: srv.Client()}
	page, err := c.ListEntries("", 0, 0)
	if err != nil {
		t.Fatalf("ListEntries: %v", err)
	}
	if page.Total != -1 {
		t.Errorf("Total = %d, want -1 for a non-numeric header", page.Total)
	}
}
