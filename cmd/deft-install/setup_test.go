package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failingCloseWriter wraps an io.Writer with a Close() that always returns
// errSimulatedFullDisk. Used to exercise the copyStream close-error
// propagation path without filesystem trickery (a real full-disk condition is
// not portable across Windows/Linux/macOS test runners).
type failingCloseWriter struct {
	w io.Writer
}

func (f *failingCloseWriter) Write(p []byte) (int, error) { return f.w.Write(p) }
func (f *failingCloseWriter) Close() error                { return errSimulatedFullDisk }

var errSimulatedFullDisk = errors.New("simulated full-disk close failure")

// TestCopyStream_ClosePropagatesError verifies the close-error capture
// pattern in copyStream: when io.Copy succeeds but Close() fails (the silent-
// truncation scenario Greptile flagged on PR #1043), the close error must
// override the nil io.Copy return so the caller sees the truncation.
func TestCopyStream_ClosePropagatesError(t *testing.T) {
	src := strings.NewReader("payload that copies cleanly\n")
	out := &failingCloseWriter{w: io.Discard}

	err := copyStream(src, out)
	if err == nil {
		t.Fatal("expected close error to propagate, got nil")
	}
	if !errors.Is(err, errSimulatedFullDisk) {
		t.Errorf("expected errSimulatedFullDisk, got %v", err)
	}
}

// recordingCloseWriter tracks Close() invocations to assert the defer fires
// even when io.Copy returns an error.
type recordingCloseWriter struct {
	writeErr error
	closed   bool
}

func (r *recordingCloseWriter) Write(p []byte) (int, error) {
	if r.writeErr != nil {
		return 0, r.writeErr
	}
	return len(p), nil
}
func (r *recordingCloseWriter) Close() error {
	r.closed = true
	return nil
}

// TestCopyStream_CopyErrorWinsOverNilClose verifies that when io.Copy fails,
// the original io.Copy error is returned (a nil Close() must NOT mask it).
// This guards the `&& err == nil` clause inside the deferred close.
func TestCopyStream_CopyErrorWinsOverNilClose(t *testing.T) {
	wantErr := errors.New("write boom")
	src := strings.NewReader("payload")
	out := &recordingCloseWriter{writeErr: wantErr}

	err := copyStream(src, out)
	if !errors.Is(err, wantErr) {
		t.Errorf("expected io.Copy error to win, got %v", err)
	}
	if !out.closed {
		t.Error("expected Close() to fire even when io.Copy failed")
	}
}

// TestCopyStream_HappyPath verifies the no-error case still returns nil and
// closes the destination.
func TestCopyStream_HappyPath(t *testing.T) {
	src := strings.NewReader("hello")
	out := &recordingCloseWriter{}

	if err := copyStream(src, out); err != nil {
		t.Errorf("unexpected error on happy path: %v", err)
	}
	if !out.closed {
		t.Error("expected Close() to fire on happy path")
	}
}

// TestCopyFile_RoundTrip is the end-to-end happy path for copyFile, kept here
// alongside the close-error tests so both axes are covered in one file.
func TestCopyFile_RoundTrip(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "src.txt")
	dst := filepath.Join(tmp, "dst.txt")

	payload := []byte("schema fixture content\nline 2\n")
	if err := os.WriteFile(src, payload, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile returned error: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Errorf("copyFile output mismatch:\nwant=%q\ngot =%q", payload, got)
	}
}

// TestCopyFile_SrcMissingReturnsError ensures the missing-source error path
// surfaces an error to the caller (no silent success).
func TestCopyFile_SrcMissingReturnsError(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "does-not-exist.txt")
	dst := filepath.Join(tmp, "dst.txt")

	if err := copyFile(src, dst); err == nil {
		t.Fatal("expected error when src is missing, got nil")
	}
}
