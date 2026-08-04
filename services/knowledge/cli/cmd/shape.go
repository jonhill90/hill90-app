package cmd

import (
	"fmt"
	"sort"
	"strings"
)

// errUnexpectedShape reports a 2xx response this CLI could not read.
//
// WHY THIS IS AN ERROR AND NOT AN EMPTY RESULT. `search` and `context` used to
// print "no results" / "(no context)" to STDOUT and exit 0 whenever the field
// they wanted was not a list. That covers a body with the key missing, the key
// set to null, or the shape changed — and it is indistinguishable, to a human
// and to a script, from a search that genuinely matched nothing. Nothing about
// an empty answer looks like a parse failure, so the human believes it.
//
// A non-2xx cannot reach here: client/akm.go checks the status and returns an
// error carrying the code and the body. This is specifically a 200 whose
// contents the CLI does not recognise.
//
// The failure must be LEGIBLE, not merely non-silent — so this names the field,
// what arrived in it, and which keys the body actually had. That is the same
// decision as services/ui/src/app/api/profile/[...path]/route.ts, which logs the
// body it could not parse instead of letting a parser's complaint stand in for
// the cause. Matching what the repository already decided rather than inventing
// a third convention.
//
// An EMPTY LIST is not this: it asserts successfully, prints nothing and exits
// 0, which is the correct answer to a search that matched nothing.
func errUnexpectedShape(field string, body map[string]interface{}) error {
	got := "absent"
	if v, present := body[field]; present {
		if v == nil {
			got = "null"
		} else {
			got = fmt.Sprintf("%T", v)
		}
	}

	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	received := "none"
	if len(keys) > 0 {
		received = strings.Join(keys, ", ")
	}

	return fmt.Errorf(
		"server response not understood: %q is %s, expected a list (keys received: %s)",
		field, got, received,
	)
}
