package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Client is the AKM HTTP client with Bearer auth and refresh-on-401.
type Client struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

// NewFromEnv creates a Client from AKM_SERVICE_URL and AKM_TOKEN env vars.
func NewFromEnv() (*Client, error) {
	url := os.Getenv("AKM_SERVICE_URL")
	if url == "" {
		return nil, fmt.Errorf("AKM_SERVICE_URL not set")
	}
	token := os.Getenv("AKM_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("AKM_TOKEN not set")
	}
	return &Client{
		BaseURL: strings.TrimRight(url, "/"),
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// doRequest performs an HTTP request with Bearer auth. On 401, attempts token refresh.
func (c *Client) doRequest(method, path string, body interface{}) ([]byte, int, error) {
	data, status, _, err := c.doRequestWithHeaders(method, path, body)
	return data, status, err
}

// doRequestWithHeaders is doRequest, keeping the response headers. Listings
// need X-Total-Count, and the plain form discarded it.
func (c *Client) doRequestWithHeaders(method, path string, body interface{}) ([]byte, int, http.Header, error) {
	data, statusCode, header, err := c.doRequestOnce(method, path, body)
	if err != nil {
		return nil, 0, nil, err
	}
	if statusCode == 401 {
		// Attempt refresh
		if refreshErr := c.refreshToken(); refreshErr != nil {
			return data, statusCode, header, nil // Return original 401
		}
		// Retry with new token
		return c.doRequestOnce(method, path, body)
	}
	return data, statusCode, header, nil
}

func (c *Client) doRequestOnce(method, path string, body interface{}) ([]byte, int, http.Header, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return nil, 0, nil, fmt.Errorf("marshal request: %w", err)
		}
		reqBody = bytes.NewReader(jsonBytes)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, reqBody)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, resp.Header, fmt.Errorf("read response: %w", err)
	}
	return data, resp.StatusCode, resp.Header, nil
}

// refreshToken attempts to refresh the JWT using the refresh secret.
func (c *Client) refreshToken() error {
	secret := c.readRefreshSecret()
	if secret == "" {
		return fmt.Errorf("no refresh secret available")
	}

	payload := map[string]string{"refresh_secret": secret}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", c.BaseURL+"/internal/agents/refresh-token", bytes.NewReader(jsonBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("refresh failed: status %d", resp.StatusCode)
	}

	var result struct {
		Token         string `json:"token"`
		RefreshSecret string `json:"refresh_secret"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}

	c.Token = result.Token

	// Write new refresh secret to file
	secretFile := os.Getenv("AKM_REFRESH_SECRET_FILE")
	if secretFile != "" {
		if err := os.WriteFile(secretFile, []byte(result.RefreshSecret), 0600); err != nil {
			return fmt.Errorf("failed to write refresh secret to %s: %w", secretFile, err)
		}
	}

	return nil
}

// readRefreshSecret reads the refresh secret from file first, then env var fallback.
func (c *Client) readRefreshSecret() string {
	secretFile := os.Getenv("AKM_REFRESH_SECRET_FILE")
	if secretFile != "" {
		data, err := os.ReadFile(secretFile)
		if err == nil && len(data) > 0 {
			return strings.TrimSpace(string(data))
		}
	}
	return os.Getenv("AKM_REFRESH_SECRET")
}

// CreateEntry creates a new knowledge entry.
func (c *Client) CreateEntry(path, content string) (map[string]interface{}, error) {
	body := map[string]string{"path": path, "content": content}
	data, status, err := c.doRequest("POST", "/api/v1/entries", body)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("create entry failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// ReadEntry reads a knowledge entry by path.
func (c *Client) ReadEntry(path string) (map[string]interface{}, error) {
	data, status, err := c.doRequest("GET", "/api/v1/entries/"+path, nil)
	if err != nil {
		return nil, err
	}
	if status == 404 {
		return nil, fmt.Errorf("entry not found: %s", path)
	}
	if status != 200 {
		return nil, fmt.Errorf("read entry failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// EntryPage is one page of a listing plus the number of entries that exist.
//
// Total is read from X-Total-Count and is NOT len(Entries). The distinction is
// the point: the server caps a page, so a caller that reports len(Entries) as
// the count prints a number that agrees with itself and calls a truncated
// listing complete.
//
// Total is -1 when the server sent no header, which means it predates the
// bound and therefore returned every row. Callers must render that as unknown
// rather than as a total.
type EntryPage struct {
	Entries []map[string]interface{}
	Total   int
}

// ListEntries lists one page of knowledge entries.
func (c *Client) ListEntries(entryType string, limit, offset int) (*EntryPage, error) {
	q := url.Values{}
	if entryType != "" {
		q.Set("type", entryType)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if offset > 0 {
		q.Set("offset", strconv.Itoa(offset))
	}
	path := "/api/v1/entries"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}

	data, status, header, err := c.doRequestWithHeaders("GET", path, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("list entries failed (status %d): %s", status, string(data))
	}

	// Still a bare JSON array. A body object here would be a hard decode
	// error for this client, which is why the total travels in a header.
	var result []map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}

	total := -1
	if raw := header.Get("X-Total-Count"); raw != "" {
		if n, convErr := strconv.Atoi(raw); convErr == nil && n >= 0 {
			total = n
		}
	}
	return &EntryPage{Entries: result, Total: total}, nil
}

// SearchEntries searches knowledge entries.
func (c *Client) SearchEntries(query string) (map[string]interface{}, error) {
	data, status, err := c.doRequest("GET", "/api/v1/search?q="+url.QueryEscape(query), nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("search failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// AppendJournal appends to today's journal.
func (c *Client) AppendJournal(content string) (map[string]interface{}, error) {
	body := map[string]string{"content": content}
	data, status, err := c.doRequest("POST", "/api/v1/journal", body)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("journal append failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// GetContext retrieves the context summary.
func (c *Client) GetContext() (map[string]interface{}, error) {
	data, status, err := c.doRequest("GET", "/api/v1/context", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("context failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}
