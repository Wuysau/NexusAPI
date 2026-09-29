package main

import (
	"errors"
	"os"
)

var (
	errIdentityDestination = errors.New("identity file exists or cannot be created; choose a new private identity path")
	errIdentitySave        = errors.New("identity could not be saved; an incomplete identity may remain; use a new private path and new pairing token")
)

type pairingIdentityFile interface {
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

// The destination must be in a directory controlled by the user. SameFile
// guards preserve observed replacements; they cannot make path operations
// atomic against a malicious owner concurrently changing that directory.
type pairingDestination struct {
	path    string
	file    pairingIdentityFile
	info    os.FileInfo
	closed  bool
	saved   bool
	cleaned bool
}

func reservePairingDestination(path string) (*pairingDestination, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errIdentityDestination
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		// Without the open handle's identity we cannot safely remove a path.
		return nil, errIdentityDestination
	}
	return &pairingDestination{path: path, file: f, info: info}, nil
}

func (d *pairingDestination) ownsPath() bool {
	current, err := os.Lstat(d.path)
	return err == nil && current.Mode().IsRegular() && os.SameFile(d.info, current)
}

func (d *pairingDestination) ownsEmptyPath() bool {
	current, err := os.Lstat(d.path)
	return err == nil && current.Mode().IsRegular() && current.Size() == 0 && os.SameFile(d.info, current)
}

func (d *pairingDestination) save(raw []byte) error {
	if d.closed || d.cleaned || !d.ownsEmptyPath() {
		return errIdentitySave
	}
	n, err := d.file.Write(raw)
	if err != nil || n != len(raw) {
		return errIdentitySave
	}
	if err := d.file.Sync(); err != nil {
		return errIdentitySave
	}
	err = d.file.Close()
	d.closed = true
	if err != nil || !d.ownsPath() {
		return errIdentitySave
	}
	d.saved = true
	return nil
}

func (d *pairingDestination) cleanup() {
	if d.cleaned {
		return
	}
	d.cleaned = true
	if !d.closed {
		d.file.Close()
		d.closed = true
	}
	// Preserve nonempty files, including partial saves: their current bytes may
	// also have been edited locally while the network or filesystem was busy.
	if !d.saved && d.ownsEmptyPath() {
		_ = os.Remove(d.path)
	}
}
