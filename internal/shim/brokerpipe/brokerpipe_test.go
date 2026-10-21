package brokerpipe

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestTokenHashMatchesNodeShim(t *testing.T) {
	// Node: sha256(literal).digest('hex').slice(0, 8).
	// sha256("test-token") = 4c5dc9b7708905f77f2e924e1acd39ad155aa1560f1e5852fea6e4e3e5ec59d6
	got := tokenHash("test-token")
	if got != "4c5dc9b7" {
		t.Fatalf("tokenHash mismatch: %q", got)
	}
	// Empty literal still hashes (Node parity).
	if len(tokenHash("")) != 8 {
		t.Fatal("empty-token hash length")
	}
}

func TestSocketPathEnvOverride(t *testing.T) {
	t.Setenv("CLAWCODE_BROKER_SOCKET", "/tmp/x.sock")
	if SocketPath() != "/tmp/x.sock" {
		t.Fatal("env override ignored")
	}
}

func TestHandshakeShape(t *testing.T) {
	// Fake broker: accept one connection, read the handshake line, echo a
	// probe body, close. Asserts field names + order-independent values.
	dir := t.TempDir()
	sock := filepath.Join(dir, "b.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	done := make(chan map[string]string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadString('\n')
		var hs map[string]string
		_ = json.Unmarshal([]byte(line), &hs)
		done <- hs
	}()

	t.Setenv("CLAWCODE_BROKER_SOCKET", sock)
	t.Setenv("CLAWCODE_AGENT", "test-agent")
	t.Setenv("OP_SERVICE_ACCOUNT_TOKEN", "test-token")

	// Run in a goroutine feeding empty stdin — the broker side closes
	// after reading the handshake, so Run returns TEMPFAIL.
	r, w, _ := os.Pipe()
	oldStdin := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = oldStdin; _ = w.Close() }()

	code := Run(discardLogger())
	if code != exitTempfail {
		t.Fatalf("expected TEMPFAIL on broker close, got %d", code)
	}
	hs := <-done
	if hs["agent"] != "test-agent" || hs["tokenHash"] != "4c5dc9b7" {
		t.Fatalf("handshake mismatch: %+v", hs)
	}
}

func TestMissingAgentIsUsageError(t *testing.T) {
	t.Setenv("CLAWCODE_AGENT", "")
	if code := Run(discardLogger()); code != exitUsage {
		t.Fatalf("expected USAGE, got %d", code)
	}
}
