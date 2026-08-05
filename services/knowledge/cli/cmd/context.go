package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var contextRaw bool

var contextCmd = &cobra.Command{
	Use:   "context",
	Short: "Get context summary",
	Long:  "Retrieve the deterministic context summary for this agent.",
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		result, err := c.GetContext()
		if err != nil {
			return err
		}

		if contextRaw {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(result)
		}

		// Pretty print sections
		sections, ok := result["sections"].([]interface{})
		if !ok {
			return errUnexpectedShape("sections", result)
		}

		// Same defect and same remedy as search.go — see its comment. A
		// section that does not decode is counted, not silently dropped:
		// context feeds an agent's prompt, so a missing section changes what
		// the model was told without changing what anyone was shown.
		skipped := 0
		shown := 0
		for _, s := range sections {
			section, ok := s.(map[string]interface{})
			if !ok {
				skipped++
				continue
			}
			shown++
			fmt.Fprintf(os.Stdout, "## [%s] %s (%s)\n",
				section["type"],
				section["title"],
				section["path"],
			)
			if content, ok := section["content"].(string); ok {
				fmt.Fprintln(os.Stdout, content)
			}
			fmt.Fprintln(os.Stdout)
		}

		if skipped > 0 {
			fmt.Fprintf(os.Stderr,
				"showing %d of %d sections — %d could not be parsed\n",
				shown, shown+skipped, skipped)
		}

		fmt.Fprintf(os.Stdout, "---\ntokens: %.0f / %.0f\n",
			result["token_count"],
			result["token_budget"],
		)
		return nil
	},
}

func init() {
	contextCmd.Flags().BoolVar(&contextRaw, "raw", false, "Output raw JSON")
}
