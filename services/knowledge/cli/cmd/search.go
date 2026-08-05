package cmd

import (
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var searchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search knowledge entries",
	Long:  "Full-text search across knowledge entries.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// Args are already validated, so anything from here is an operational
		// failure. Without this cobra prints the whole usage block after the
		// error, which buries the one line the operator needs.
		cmd.SilenceUsage = true

		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		result, err := c.SearchEntries(args[0])
		if err != nil {
			return err
		}

		results, ok := result["results"].([]interface{})
		if !ok {
			return errUnexpectedShape("results", result)
		}

		// A DROPPED ROW MUST BE COUNTED, not just skipped. shape.go's
		// errUnexpectedShape already closed the top-level version of this —
		// a missing or null `results` printed "no results" and exited 0. This
		// is the same defect one layer down: the list is fine, an element in
		// it is not, and `continue` alone means the operator sees fewer rows
		// than exist with nothing saying so. A partial answer presented as a
		// complete one.
		//
		// Reported on STDERR, matching list.go's truncation summary, so a
		// parsed pipeline reading stdout is unaffected — same reasoning that
		// file already records for its own summary.
		skipped := 0
		shown := 0
		for _, r := range results {
			entry, ok := r.(map[string]interface{})
			if !ok {
				skipped++
				continue
			}
			shown++
			fmt.Fprintf(os.Stdout, "%.2f  %-40s %s\n",
				entry["score"],
				entry["path"],
				entry["title"],
			)
			if headline, ok := entry["headline"].(string); ok {
				fmt.Fprintf(os.Stdout, "       %s\n", headline)
			}
		}
		if skipped > 0 {
			fmt.Fprintf(os.Stderr,
				"showing %d of %d — %d could not be parsed\n",
				shown, shown+skipped, skipped)
		}
		return nil
	},
}
