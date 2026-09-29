package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type faultedIdentityFile struct {
	*os.File
	write func([]byte) (int, error)
	sync  func() error
	close func() error
}

func (f *faultedIdentityFile) Write(raw []byte) (int, error) {
	if f.write != nil {
		return f.write(raw)
	}
	return f.File.Write(raw)
}

func (f *faultedIdentityFile) Sync() error {
	if f.sync != nil {
		return f.sync()
	}
	return f.File.Sync()
}

func (f *faultedIdentityFile) Close() error {
	if f.close != nil {
		return f.close()
	}
	return f.File.Close()
}

func reservedDestination(t *testing.T) *pairingDestination {
	t.Helper()
	d, err := reservePairingDestination(filepath.Join(t.TempDir(), "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.cleanup)
	return d
}

func TestPairingDestinationFailurePreservesNonemptyData(t *testing.T) {
	for _, failure := range []string{"write before data", "partial write", "short write", "sync", "close"} {
		t.Run(failure, func(t *testing.T) {
			d := reservedDestination(t)
			f := &faultedIdentityFile{File: d.file.(*os.File)}
			privateFailure := errors.New("PRIVATE_FILESYSTEM_ERROR_WITH_PATH")
			switch failure {
			case "write before data":
				f.write = func([]byte) (int, error) { return 0, privateFailure }
			case "partial write", "short write":
				f.write = func(raw []byte) (int, error) {
					n, err := f.File.Write(raw[:5])
					if failure == "partial write" {
						return n, privateFailure
					}
					return n, err
				}
			case "sync":
				f.sync = func() error { return privateFailure }
			case "close":
				f.close = func() error {
					f.File.Close()
					return privateFailure
				}
			}
			d.file = f
			raw := []byte(`{"credential":"PRIVATE_IDENTITY"}`)
			if err := d.save(raw); err != errIdentitySave {
				t.Fatalf("save failure must use the static sanitized error: %v", err)
			}
			d.cleanup()
			got, err := os.ReadFile(d.path)
			if failure == "write before data" {
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatal("own empty failed reservation was not removed")
				}
				return
			}
			want := raw
			if failure == "partial write" || failure == "short write" {
				want = raw[:5]
			}
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("nonempty identity content was changed during cleanup: %v", err)
			}
		})
	}
}

func TestPairingDestinationReplacementBeforeSaveIsPreserved(t *testing.T) {
	d := reservedDestination(t)
	moved := d.path + ".original"
	if err := os.Rename(d.path, moved); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		// Windows may deny renaming an open file. Preserve the original inode
		// by moving it after close, then test the same replacement guard.
		d.file.Close()
		if err := os.Rename(d.path, moved); err != nil {
			t.Fatal(err)
		}
	}
	replacement := []byte("EXISTING_REPLACEMENT_IDENTITY")
	if err := os.WriteFile(d.path, replacement, 0600); err != nil {
		t.Fatal(err)
	}
	if err := d.save([]byte("NEW_IDENTITY")); err != errIdentitySave {
		t.Fatalf("save accepted a replaced destination: %v", err)
	}
	d.cleanup()
	got, err := os.ReadFile(d.path)
	if err != nil || !bytes.Equal(got, replacement) {
		t.Fatalf("replacement identity was not preserved: %v", err)
	}
	original, err := os.ReadFile(moved)
	if err != nil || len(original) != 0 {
		t.Fatalf("save wrote to the stale original handle: %v", err)
	}
}

func TestPairingDestinationReplacementBeforeSuccessIsDetected(t *testing.T) {
	d := reservedDestination(t)
	f := &faultedIdentityFile{File: d.file.(*os.File)}
	replacement := []byte("OTHER_PROCESS_IDENTITY")
	f.close = func() error {
		if err := f.File.Close(); err != nil {
			return err
		}
		if err := os.Rename(d.path, d.path+".original"); err != nil {
			return err
		}
		return os.WriteFile(d.path, replacement, 0600)
	}
	d.file = f
	if err := d.save([]byte("NEW_IDENTITY")); err != errIdentitySave {
		t.Fatalf("save reported success for a replaced destination: %v", err)
	}
	d.cleanup()
	got, err := os.ReadFile(d.path)
	if err != nil || !bytes.Equal(got, replacement) {
		t.Fatalf("replacement identity was changed: %v", err)
	}
}

func TestPairingDestinationSymlinkIsNotFollowed(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "target.json"), filepath.Join(dir, "link.json")
	original := []byte("EXISTING_LINK_TARGET")
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("Windows environment does not permit creating symlinks")
		}
		t.Fatal(err)
	}
	if _, err := reservePairingDestination(link); err != errIdentityDestination {
		t.Fatalf("symlink destination accepted: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("symlink target changed: %v", err)
	}
}
