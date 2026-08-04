package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A 200 whose body this CLI cannot read must be an ERROR, not an empty answer.
//
// `search` and `context` printed "no results" / "(no context)" to stdout and
// exited 0 whenever the field they wanted was not a list — a body with the key
// missing, the key null, or the shape changed. To a human that is a search that
// matched nothing, because nothing about an empty answer looks like a parse
// failure. To a script it is exit 0 with clean stdout.
//
// THE FIXTURE MUST LACK THE KEY. With a well-formed empty list — `{"results":
// []}` — the broken and fixed versions both print nothing and exit 0, so a test
// built on that fixture passes on the defect. Sixth instance this session of the
// same test-design mistake: a total that agrees with itself, a search count below
// the cap, an optimistic ui on a successful response, a succeeding command with a
// hardcoded exit code, a proxy fixture with no header, and now a well-formed
// empty list.

func serving(t *testing.T, body string) func() {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	t.Setenv("AKM_SERVICE_URL", srv.URL)
	t.Setenv("AKM_TOKEN", "test-token")
	return srv.Close
}

func TestSearchUnrecognisedBodyIsAnError(t *testing.T) {
	// POSITIVE CONTROL: the key is absent entirely. A well-formed empty list
	// cannot tell the versions apart.
	defer serving(t, `{"query":"x","count":0}`)()

	err := searchCmd.RunE(searchCmd, []string{"anything"})
	if err == nil {
		t.Fatal("expected an error for a body with no results key; got nil (the old code printed \"no results\" and exited 0)")
	}
	for _, want := range []string{`"results"`, "absent", "count", "query"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should name what came back; missing %q in: %s", want, err)
		}
	}
}

func TestSearchNullResultsIsAnError(t *testing.T) {
	// `null` is not an empty list. It asserts to nil, which the old code also
	// printed as "no results".
	defer serving(t, `{"query":"x","results":null}`)()

	err := searchCmd.RunE(searchCmd, []string{"anything"})
	if err == nil {
		t.Fatal("expected an error for results:null; got nil")
	}
	if !strings.Contains(err.Error(), "null") {
		t.Errorf("error should say the field was null, got: %s", err)
	}
}

func TestSearchEmptyListIsNotAnError(t *testing.T) {
	// GUARD RAIL, and the reason it is not the control: this passes on the broken
	// code too. A search that matched nothing must stay silent and succeed.
	defer serving(t, `{"query":"x","results":[],"count":0}`)()

	if err := searchCmd.RunE(searchCmd, []string{"anything"}); err != nil {
		t.Fatalf("an empty result set is a valid answer, not a failure: %v", err)
	}
}

func TestSearchWithResultsSucceeds(t *testing.T) {
	defer serving(t, `{"query":"x","results":[{"score":1.0,"path":"a.md","title":"A"}]}`)()

	if err := searchCmd.RunE(searchCmd, []string{"anything"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestContextUnrecognisedBodyIsAnError(t *testing.T) {
	// search.go's twin — both had the shape, so both are covered.
	defer serving(t, `{"token_count":0,"token_budget":100}`)()

	err := contextCmd.RunE(contextCmd, []string{})
	if err == nil {
		t.Fatal("expected an error for a body with no sections key; got nil")
	}
	if !strings.Contains(err.Error(), `"sections"`) {
		t.Errorf("error should name the field, got: %s", err)
	}
}

func TestContextEmptySectionsIsNotAnError(t *testing.T) {
	defer serving(t, `{"sections":[],"token_count":0,"token_budget":100}`)()

	if err := contextCmd.RunE(contextCmd, []string{}); err != nil {
		t.Fatalf("no sections is a valid answer: %v", err)
	}
}

func TestErrUnexpectedShapeNamesWhatArrived(t *testing.T) {
	err := errUnexpectedShape("results", map[string]interface{}{
		"error": "boom",
		"query": "x",
	})
	msg := err.Error()
	// Naming the keys is what turns "I could not read it" into something
	// actionable — here it reveals the server sent an error object with a 200.
	for _, want := range []string{`"results"`, "absent", "error, query"} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing %q in: %s", want, msg)
		}
	}
}

func TestErrUnexpectedShapeOnEmptyBody(t *testing.T) {
	err := errUnexpectedShape("results", map[string]interface{}{})
	if !strings.Contains(err.Error(), "none") {
		t.Errorf("an empty body should say so plainly, got: %s", err)
	}
}
