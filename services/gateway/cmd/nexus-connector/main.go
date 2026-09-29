package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"nexus/gateway/connectorclient"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: nexus-connector pair|run --config connector.json --identity connector-identity.json")
	}
	action := os.Args[1]
	flags := flag.NewFlagSet(action, flag.ContinueOnError)
	configPath := flags.String("config", "connector.json", "local configuration")
	identityPath := flags.String("identity", "connector-identity.json", "private identity file")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		return fmt.Errorf("local configuration unavailable")
	}
	var config connectorclient.Config
	if json.Unmarshal(raw, &config) != nil {
		return fmt.Errorf("invalid local configuration")
	}
	client, err := connectorclient.New(config)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch action {
	case "pair":
		// Read from stdin, keeping one-time credentials out of shell history and argv.
		fmt.Fprintln(os.Stderr, "Paste one-time pairing token, then press Enter:")
		token, err := readPairingToken(ctx, os.Stdin)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil && err != io.EOF {
			return fmt.Errorf("pairing input unavailable")
		}
		identity, err := client.Pair(ctx, token)
		if err != nil {
			return err
		}
		raw, _ := json.MarshalIndent(identity, "", "  ")
		f, err := os.OpenFile(*identityPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("identity file exists or cannot be created; choose a new private identity path")
		}
		_, err = f.Write(raw)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			return fmt.Errorf("identity could not be saved; generate a new pairing token")
		}
		fmt.Println("Paired. Identity saved locally. Start with the run command.")
		return nil
	case "run":
		raw, err := os.ReadFile(*identityPath)
		if err != nil {
			return fmt.Errorf("identity file unavailable; pair first")
		}
		var identity connectorclient.Identity
		if json.Unmarshal(raw, &identity) != nil {
			return fmt.Errorf("invalid identity file")
		}
		fmt.Println("Connector starting; local allowlist and verified remote TLS are enforced.")
		return client.Run(ctx, identity)
	default:
		return fmt.Errorf("unknown action; use pair or run")
	}
}

// readPairingToken is only for this one-shot CLI process. Windows console reads
// and Close can both block; cancellation must let main exit without joining
// them. Redirected input is closed asynchronously so its read can finish too.
// Do not reuse this process-scoped pattern in the connector client library.
func readPairingToken(ctx context.Context, input io.ReadCloser) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	type result struct {
		token string
		err   error
	}
	read := make(chan result, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		token, err := bufio.NewReader(io.LimitReader(input, 256)).ReadString('\n')
		read <- result{token: token, err: err}
	}()
	select {
	case <-ctx.Done():
		go input.Close()
		return "", ctx.Err()
	case value := <-read:
		<-done
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return value.token, value.err
	}
}
