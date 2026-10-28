package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// confirmDestructive gates every command that removes data or rewrites a whole
// collection (unbind, delete, bulk sync). Both paths fail closed:
//
//   - scripted / agent runs (stdin is not a terminal) must pass --yes. Without
//     it the command aborts with an actionable error and touches nothing, so an
//     agent cannot delete on its own initiative — a person has to approve the
//     exact command first.
//   - interactive runs get a y/N prompt, mirroring the UI's confirm dialogs.
//
// question must name the object and what becomes unrecoverable; the caller is
// the last place that still knows both.
func confirmDestructive(cmd *cobra.Command, question string) error {
	if yes, _ := cmd.Flags().GetBool("yes"); yes {
		return nil
	}
	if !stdinIsTerminal() {
		return fmt.Errorf("%s\nrefusing to run without --yes: there is no terminal to confirm on (agent/scripted run). Ask the person to approve, then re-run with --yes", question)
	}
	fmt.Fprintf(os.Stderr, "%s\nContinue? [y/N] ", question)
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
		return nil
	}
	return errors.New("aborted: nothing was changed")
}

// stdinIsTerminal is a variable so tests can pin it. `go test` inherits the
// caller's terminal, so a test that reached the real prompt would block forever.
var stdinIsTerminal = func() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// addDestructiveFlags declares the confirmation flag shared by every gated
// command so `--help` tells the person why it exists.
func addDestructiveFlags(cmd *cobra.Command) {
	cmd.Flags().BoolP("yes", "y", false, "Confirm the destructive step (required when stdin is not a terminal)")
}
