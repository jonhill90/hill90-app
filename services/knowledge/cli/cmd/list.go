package cmd

import (
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var (
	listType   string
	listLimit  int
	listOffset int
)

var listCmd = &cobra.Command{
	Use:   "list [--type <type>] [--limit <n>] [--offset <n>]",
	Short: "List knowledge entries",
	Long:  "List one page of knowledge entries, optionally filtered by type.\n\nThe server bounds the page. A summary on stderr reports how many exist, so a\ntruncated listing is never mistaken for a complete one.",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		page, err := c.ListEntries(listType, listLimit, listOffset)
		if err != nil {
			return err
		}

		for _, entry := range page.Entries {
			fmt.Fprintf(os.Stdout, "%-8s %-40s %s\n",
				entry["entry_type"],
				entry["path"],
				entry["title"],
			)
		}

		// The summary goes to STDERR so it never lands in a pipeline that is
		// parsing the listing. It exists because this command used to print a
		// page and stop: a truncated list that looked complete, which is the
		// same defect the UI had and the reason the server bounds the query
		// at all.
		shown := len(page.Entries)
		switch {
		case page.Total < 0:
			// No X-Total-Count: an older server, which returned every row.
			// Report what is shown WITHOUT claiming it is all of them.
			fmt.Fprintf(os.Stderr, "%d shown (server reported no total)\n", shown)
		case page.Total > listOffset+shown:
			fmt.Fprintf(os.Stderr,
				"showing %d of %d — use --offset %d for the next page\n",
				shown, page.Total, listOffset+shown)
		default:
			fmt.Fprintf(os.Stderr, "%d of %d\n", shown, page.Total)
		}
		return nil
	},
}

func init() {
	listCmd.Flags().StringVar(&listType, "type", "", "Filter by entry type (plan, decision, journal, etc.)")
	listCmd.Flags().IntVar(&listLimit, "limit", 0, "Max entries to return (server default 500, max 2000)")
	listCmd.Flags().IntVar(&listOffset, "offset", 0, "Entries to skip before the page")
}
