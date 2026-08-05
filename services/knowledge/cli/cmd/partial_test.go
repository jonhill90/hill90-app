package cmd

import (
	"io"
	"os"
	"strings"
	"testing"
)

// A PARTIAL ANSWER MUST NOT LOOK LIKE A COMPLETE ONE (#439).
//
// `search` and `context` walked their result list and did `continue` on any
// element that was not a map — no warning, no count, exit 0. The operator saw
// fewer rows than the server sent and nothing said so.
//
// This is the same defect shape.go's errUnexpectedShape already closed one
// layer up, where a missing or null `results` printed "no results". The list
// being valid while an element in it is not is the case that survived.
//
// THE FIXTURE MUST MIX GOOD AND BAD ELEMENTS. With every element malformed the
// command prints nothing, which is indistinguishable from an empty result set
// and passes on the broken code; with none malformed there is nothing to
// report. Only a mix separates "showed you everything" from "showed you what
// it could" — the same fixture-design trap shape_test.go's own header records
// six instances of.

// captureStderr swaps os.Stderr for a pipe. The commands write with
// fmt.Fprintf(os.Stderr, ...), which resolves the variable at call time, so
// the swap is seen.
func captureStderr(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("could not create pipe: %v", err)
	}
	os.Stderr = w

	runErr := fn()

	_ = w.Close()
	os.Stderr = orig
	out, readErr := io.ReadAll(r)
	if readErr != nil {
		t.Fatalf("could not read captured stderr: %v", readErr)
	}
	return string(out), runErr
}

func TestSearchReportsUnparseableResults(t *testing.T) {
	// Two decode, one is a bare string, one is null. Four sent, two shown.
	defer serving(t, `{"query":"x","results":[
		{"score":1.0,"path":"a.md","title":"A"},
		"not-an-object",
		{"score":0.5,"path":"b.md","title":"B"},
		null
	]}`)()

	stderr, err := captureStderr(t, func() error {
		return searchCmd.RunE(searchCmd, []string{"anything"})
	})
	if err != nil {
		t.Fatalf("a mixed response is still a usable answer, not a failure: %v", err)
	}

	// THE ASSERTION THAT MATTERS: the count is reported at all.
	if stderr == "" {
		t.Fatal("two of four results were dropped and nothing was said — the old behaviour")
	}
	for _, want := range []string{"showing 2 of 4", "2 could not be parsed"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr should say what was lost; missing %q in: %s", want, stderr)
		}
	}
}

func TestSearchSaysNothingWhenEverythingParses(t *testing.T) {
	// GUARD RAIL: a clean response must stay quiet, or the summary becomes
	// noise on every single search and gets tuned out — which is how a real
	// warning stops being read.
	defer serving(t, `{"query":"x","results":[
		{"score":1.0,"path":"a.md","title":"A"},
		{"score":0.5,"path":"b.md","title":"B"}
	]}`)()

	stderr, err := captureStderr(t, func() error {
		return searchCmd.RunE(searchCmd, []string{"anything"})
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stderr != "" {
		t.Errorf("a fully-parseable response must print no summary; got: %s", stderr)
	}
}

func TestContextReportsUnparseableSections(t *testing.T) {
	defer serving(t, `{"sections":[
		{"type":"note","title":"A","path":"a.md","content":"body"},
		42,
		{"type":"note","title":"B","path":"b.md","content":"body"}
	],"token_count":10,"token_budget":100}`)()

	stderr, err := captureStderr(t, func() error {
		return contextCmd.RunE(contextCmd, []string{"anything"})
	})
	if err != nil {
		t.Fatalf("a mixed response is still a usable answer, not a failure: %v", err)
	}

	if stderr == "" {
		t.Fatal("one of three sections was dropped and nothing was said — the old behaviour")
	}
	for _, want := range []string{"showing 2 of 3", "1 could not be parsed"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr should say what was lost; missing %q in: %s", want, stderr)
		}
	}
}

func TestContextSaysNothingWhenEverythingParses(t *testing.T) {
	defer serving(t, `{"sections":[
		{"type":"note","title":"A","path":"a.md","content":"body"}
	],"token_count":10,"token_budget":100}`)()

	stderr, err := captureStderr(t, func() error {
		return contextCmd.RunE(contextCmd, []string{"anything"})
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stderr != "" {
		t.Errorf("a fully-parseable response must print no summary; got: %s", stderr)
	}
}
