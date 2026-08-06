package cmd

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// PAGE BOUNDARIES ARE WHERE "A TRUNCATED LIST THAT LOOKED COMPLETE" IS BORN
// (list.go's own comment names this defect by name — the same one this
// package's other commands were fixed for). Investigated before writing
// anything: walked the switch in list.go by hand against all three
// boundaries below, then verified computationally with these real fixtures
// rather than trusting the hand walk. The logic reads correct — every
// branch uses the off-by-one-free comparison `page.Total > listOffset+shown`
// — it was simply untested, so these are coverage, not a fix. If a future
// edit gets the comparison direction or the `>` vs `>=` wrong, exactly one
// of the three tests below will start failing at that boundary.
//
// A test that only covers the happy middle (three items, one page, done)
// would pass against an off-by-one bug at the boundary. These three
// specifically exercise: a page exactly the size of the remaining total (no
// more to show), a page one item short of the total (exactly one more
// exists), and an offset that has run past the end (an empty final page).

// servingWithTotal is serving() (shape_test.go) plus a controlled
// X-Total-Count header — list.go's summary line depends on that header, not
// on len(Entries), which plain serving() has no way to set.
func servingWithTotal(t *testing.T, body string, total int) func() {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Total-Count", strconv.Itoa(total))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	t.Setenv("AKM_SERVICE_URL", srv.URL)
	t.Setenv("AKM_TOKEN", "test-token")
	return srv.Close
}

func runList(t *testing.T, entryType string, limit, offset int) (string, error) {
	t.Helper()
	origType, origLimit, origOffset := listType, listLimit, listOffset
	listType, listLimit, listOffset = entryType, limit, offset
	t.Cleanup(func() { listType, listLimit, listOffset = origType, origLimit, origOffset })

	return captureStderr(t, func() error {
		return listCmd.RunE(listCmd, nil)
	})
}

// BOUNDARY 1: a page exactly the size of what remains — Total == offset +
// shown exactly. No more entries exist past this page. The comparison
// `page.Total > listOffset+shown` must be false here (equal, not greater),
// landing in the default branch with no "next page" hint. A `>=` in place
// of `>` would falsely claim more exists when there is none.
func TestListExactlyFillsRemainingTotal(t *testing.T) {
	defer servingWithTotal(t, `[
		{"entry_type":"plan","path":"a.md","title":"A"},
		{"entry_type":"plan","path":"b.md","title":"B"}
	]`, 2)()

	stderr, err := runList(t, "", 2, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stderr, "2 of 2") {
		t.Errorf("expected the no-more-pages summary %q; got: %s", "2 of 2", stderr)
	}
	if strings.Contains(stderr, "next page") {
		t.Errorf("must not claim a next page exists when Total == offset+shown; got: %s", stderr)
	}
}

// BOUNDARY 2: exactly one entry exists beyond this page — Total ==
// offset + shown + 1. This is the sharpest edge for an off-by-one: the
// comparison must correctly read "more exists" from a margin of exactly
// one, not just from an obviously-larger remainder.
func TestListOneEntryRemainsBeyondPage(t *testing.T) {
	defer servingWithTotal(t, `[
		{"entry_type":"plan","path":"a.md","title":"A"},
		{"entry_type":"plan","path":"b.md","title":"B"}
	]`, 3)()

	stderr, err := runList(t, "", 2, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"showing 2 of 3", "next page"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("expected the more-remains summary to contain %q; got: %s", want, stderr)
		}
	}
	if !strings.Contains(stderr, "--offset 2") {
		t.Errorf("expected the next page's offset to be 2 (0 + 2 shown); got: %s", stderr)
	}
}

// BOUNDARY 3: an empty final page — offset has run past every entry.
// shown == 0, Total > 0. This is the case that would print an unqualified
// "0" and read as "nothing exists" if the summary ever dropped the total —
// it must still report the real total, not just the empty page.
func TestListEmptyPageAtEndOfTotal(t *testing.T) {
	defer servingWithTotal(t, `[]`, 4)()

	stderr, err := runList(t, "", 2, 4)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stderr, "0 of 4") {
		t.Errorf("an empty final page must still report the real total; got: %s", stderr)
	}
	if strings.Contains(stderr, "next page") {
		t.Errorf("must not claim a next page exists past the end of the total; got: %s", stderr)
	}
}

// GUARD RAIL: no X-Total-Count at all (a pre-bound server) must render as
// unknown, never as a total of zero or a claim of completeness.
func TestListNoTotalHeaderIsReportedAsUnknown(t *testing.T) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Deliberately no X-Total-Count.
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[{"entry_type":"plan","path":"a.md","title":"A"}]`))
	}))
	defer srv.Close()
	t.Setenv("AKM_SERVICE_URL", srv.URL)
	t.Setenv("AKM_TOKEN", "test-token")

	stderr, err := runList(t, "", 0, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stderr, "no total") {
		t.Errorf("a missing X-Total-Count must be reported as unknown, not silently omitted; got: %s", stderr)
	}
}
