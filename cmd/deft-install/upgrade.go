package main

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Payload layout classifications (#1425). The installer's --upgrade path MUST
// know whether <core> is a genuine git clone of the framework, a vendored
// (no-.git) payload deposited by the webinstaller, or absent entirely --
// because running a mutating git command inside a vendored payload resolves,
// via git's upward .git discovery, to the PARENT consumer repository. That is
// the P0 safety bug this module closes: `git -C .deft/core checkout <tag>` on
// a no-.git payload would check out a ref in the user's own project repo.
const (
	payloadLayoutClone    = "clone"
	payloadLayoutVendored = "vendored"
	payloadLayoutAbsent   = "absent"
)

// Upgrade strategies surfaced in --json diagnostics (#1425).
const (
	strategyGitCheckout = "git-checkout"
	strategyFileSwap    = "file-swap"
	strategyClone       = "clone"
)

// deftTarballAPIBase is the GitHub tarball endpoint for the framework repo.
// `GET .../tarball/<ref>` (ref optional => default branch) returns a gzipped
// tar of the repo tree wrapped in a single top-level directory named
// `<owner>-<repo>-<sha>` -- the wrapper SHA is the framework source SHA we
// re-stamp into the VERSION manifest (fixing the #1323/#1324 wrong-sha class).
const deftTarballAPIBase = "https://api.github.com/repos/deftai/directive/tarball"

// tarballExcludedTopLevel mirrors the webinstaller's EXCLUDED_PREFIXES
// (deftai/webinstaller src/lib/bootstrap/emitDeftCore.ts): a vendored payload
// never carries git metadata, GitHub workflow files, or node_modules.
// Critically, .git/ MUST NEVER be written into <core> or the NEXT --upgrade
// would mis-classify the vendored payload as a clone and re-introduce the
// safety bug.
var tarballExcludedTopLevel = map[string]bool{
	".git":         true,
	".github":      true,
	"node_modules": true,
}

// UpdateOutcome reports what the update path did so main.go can populate the
// --json diagnostics (payload_layout / strategy) and re-stamp the VERSION
// manifest with the framework source SHA resolved from the tarball rather than
// the parent consumer repo's HEAD (the #1323/#1324 wrong-sha class).
type UpdateOutcome struct {
	Layout   string // clone | vendored | absent
	Strategy string // git-checkout | file-swap | clone
	SHA      string // framework source SHA (best-effort)
	Tag      string // resolved release tag, when the ref looked like semver
	Backup   string // path to the pre-swap backup of <core>, when a swap ran
}

// runGitCaptureFunc runs `git -C dir args...` and returns trimmed stdout.
// Indirected through a var so tests can stub git without a real repo. ONLY
// read-only git subcommands are ever routed through this helper -- mutating
// git is confined to updateClonedCore, which runs exclusively on the "clone"
// layout (#1425 safety guardrail).
var runGitCaptureFunc = func(dir string, args ...string) (string, error) {
	full := append([]string{"-C", dir}, args...)
	out, err := exec.Command("git", full...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// fetchCoreTarballFunc downloads the deftai/directive source tarball at ref
// (empty => default branch) to a temp .tar.gz and returns its path. Indirected
// for tests so the vendored-refresh path is exercised without network.
var fetchCoreTarballFunc = downloadCoreTarball

// UpdateDeft refreshes an existing framework deposit. It classifies the
// on-disk payload layout FIRST and dispatches to the only safe strategy for
// that layout (#1425):
//
//   - clone    -> git fetch/checkout/pull (the only path allowed to run
//     mutating git, and only because classification proved `git rev-parse
//     --show-toplevel` resolves to <core> itself).
//   - vendored -> git-free file swap (download tarball, atomic replace).
//   - absent   -> fresh clone (treat --upgrade on a missing payload as install).
//
// The hard guardrail is structural: a mutating git command can only be reached
// through updateClonedCore, which is only called from the clone branch.
func UpdateDeft(w *Wizard, result *WizardResult, branch string) (*UpdateOutcome, error) {
	layout := classifyPayloadLayout(result.DeftDir)
	switch layout {
	case payloadLayoutClone:
		if err := updateClonedCore(w, result, branch); err != nil {
			return &UpdateOutcome{Layout: layout, Strategy: strategyGitCheckout}, err
		}
		sha, _ := runGitCaptureFunc(result.DeftDir, "rev-parse", "HEAD")
		return &UpdateOutcome{
			Layout:   layout,
			Strategy: strategyGitCheckout,
			SHA:      sha,
			Tag:      tagFromRef(branch),
		}, nil
	case payloadLayoutVendored:
		return refreshVendoredCore(w, result, branch)
	default: // absent -- treat --upgrade on a missing payload as a fresh clone.
		w.printf("No framework payload found at %s; cloning a fresh copy ...\n", result.DeftDir)
		if err := CloneDeft(w, result, branch); err != nil {
			return &UpdateOutcome{Layout: layout, Strategy: strategyClone}, err
		}
		sha, _ := runGitCaptureFunc(result.DeftDir, "rev-parse", "HEAD")
		// Report the POST-operation layout: a fresh clone now exists, so the
		// payload is a clone (not absent). Consumers inspecting payload_layout
		// in --json must see the resulting state, not the pre-clone state.
		return &UpdateOutcome{
			Layout:   payloadLayoutClone,
			Strategy: strategyClone,
			SHA:      sha,
			Tag:      tagFromRef(branch),
		}, nil
	}
}

// classifyPayloadLayout determines whether <deftDir> is a genuine framework
// clone, a vendored (no-.git) payload, or absent. This is the safety
// pre-condition for every git operation in the --upgrade path (#1425): only a
// "clone" layout -- where `git rev-parse --show-toplevel` resolves to <deftDir>
// itself -- is allowed to run mutating git commands. A vendored payload's git
// toplevel resolves to the PARENT consumer repo (or git fails outright), so it
// MUST use the git-free file-swap path instead.
func classifyPayloadLayout(deftDir string) string {
	info, err := os.Stat(deftDir)
	if err != nil || !info.IsDir() {
		return payloadLayoutAbsent
	}
	top, err := runGitCaptureFunc(deftDir, "rev-parse", "--show-toplevel")
	if err != nil || strings.TrimSpace(top) == "" {
		// Not a git work tree at all -> vendored payload.
		return payloadLayoutVendored
	}
	if samePath(top, deftDir) {
		return payloadLayoutClone
	}
	// git resolved to a DIFFERENT toplevel: <deftDir> is nested inside another
	// repo (the parent consumer project) and is not itself a repo. Vendored.
	return payloadLayoutVendored
}

// updateClonedCore runs the git fetch/checkout/pull refresh for a GENUINE
// framework clone. The caller MUST have classified the payload as
// payloadLayoutClone first -- this is the only function permitted to run
// mutating git commands, and only because classification proved `git rev-parse
// --show-toplevel` resolves to <core> itself (never the parent repo). (#1425)
func updateClonedCore(w *Wizard, result *WizardResult, branch string) error {
	w.printf("Updating deft at %s ...\n", result.DeftDir)

	if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "fetch", "origin"); err != nil {
		return fmt.Errorf("git fetch failed: %w", err)
	}

	if branch != "" {
		w.printf("Switching to branch %s ...\n", branch)
		if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "checkout", branch); err != nil {
			return fmt.Errorf("git checkout %s failed: %w", branch, err)
		}
	}

	if err := runCmdFunc(w.out, "git", "-C", result.DeftDir, "pull"); err != nil {
		return fmt.Errorf("git pull failed: %w", err)
	}

	w.printf("Deft updated successfully.\n")
	return nil
}

// refreshVendoredCore upgrades a vendored (no-.git) payload WITHOUT touching
// git at all: it downloads the release tarball, extracts it out-of-place, and
// atomically replaces <core> with a timestamped backup for rollback. This both
// closes the safety bug (no git command ever runs against the consumer repo)
// and makes the canonical upgrade actually WORK for webinstaller users (#1425).
func refreshVendoredCore(w *Wizard, result *WizardResult, branch string) (*UpdateOutcome, error) {
	outcome := &UpdateOutcome{
		Layout:   payloadLayoutVendored,
		Strategy: strategyFileSwap,
		Tag:      tagFromRef(branch),
	}
	w.printf("Detected a vendored framework payload at %s (no .git of its own).\n", result.DeftDir)
	w.printf("Refreshing via git-free file swap -- the installer will NOT run git against your project repo ...\n")

	tarballPath, err := fetchCoreTarballFunc(branch)
	if err != nil {
		return outcome, fmt.Errorf("vendored refresh: could not download the release tarball for %s: %w", refLabel(branch), err)
	}
	defer os.Remove(tarballPath)

	staging, err := os.MkdirTemp("", "deft-core-stage-*")
	if err != nil {
		return outcome, fmt.Errorf("vendored refresh: could not create staging dir: %w", err)
	}
	defer os.RemoveAll(staging)

	contentRoot, err := extractCoreTarball(tarballPath, staging)
	if err != nil {
		return outcome, fmt.Errorf("vendored refresh: could not extract tarball: %w", err)
	}
	if sha := shaFromContentRoot(contentRoot); sha != "" {
		outcome.SHA = sha
	}

	backup, err := swapInCore(result.DeftDir, contentRoot)
	if err != nil {
		return outcome, fmt.Errorf("vendored refresh: %w", err)
	}
	outcome.Backup = backup

	w.printf("Vendored framework refreshed at %s (previous payload backed up at %s).\n", result.DeftDir, backup)
	return outcome, nil
}

// downloadCoreTarball fetches the framework source tarball at ref (empty =>
// default branch) to a temp .tar.gz and returns its path. Reuses the
// long-lived installerDownloadClient (transport-level timeouts + generous body
// backstop) so a slow link does not abort a healthy stream.
func downloadCoreTarball(ref string) (string, error) {
	url := deftTarballAPIBase
	if ref != "" {
		url += "/" + ref
	}
	resp, err := installerDownloadClient.Get(url)
	if err != nil {
		return "", fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("GET %s: HTTP %s", url, resp.Status)
	}

	f, err := os.CreateTemp("", "deft-core-*.tar.gz")
	if err != nil {
		return "", fmt.Errorf("create temp tarball: %w", err)
	}
	tmp := f.Name()
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", fmt.Errorf("download tarball body: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("close temp tarball: %w", err)
	}
	return tmp, nil
}

// extractCoreTarball extracts the gzipped tar at tarballPath into destDir and
// returns the absolute path to the single top-level content directory the
// GitHub tarball wraps everything in. Entries under an excluded top-level
// component (.git / .github / node_modules) -- and any stray `.git` path
// component anywhere -- are skipped so a vendored refresh never carries git
// metadata (#1425). Guards against path traversal (zip-slip): any entry that
// would escape destDir is rejected.
func extractCoreTarball(tarballPath, destDir string) (string, error) {
	f, err := os.Open(tarballPath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	cleanDest := filepath.Clean(destDir)
	rootName := ""

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("tar: %w", err)
		}

		name := strings.TrimPrefix(filepath.ToSlash(hdr.Name), "./")
		if name == "" {
			continue
		}
		parts := strings.Split(name, "/")
		if rootName == "" {
			rootName = parts[0]
		}
		// zip-slip / CodeQL go/zipslip: reject any path-traversal segment on the
		// RAW entry name before it is used in any filesystem operation. GitHub
		// source tarballs never contain ".." segments, so this is a no-op for
		// valid input and closes the traversal taint path at the source.
		for _, seg := range parts {
			if seg == ".." {
				return "", fmt.Errorf("tar entry contains a '..' path segment: %q", hdr.Name)
			}
		}
		if tarPathExcluded(parts) {
			continue
		}

		target := filepath.Join(cleanDest, filepath.FromSlash(name))
		// zip-slip / CodeQL go/zipslip canonical barrier: the cleaned target
		// path MUST stay within destDir. Wrapping the target in filepath.Clean
		// is the form CodeQL recognises as a sanitizer on the path that flows
		// into the MkdirAll / OpenFile sinks below.
		if !strings.HasPrefix(filepath.Clean(target), cleanDest+string(os.PathSeparator)) {
			return "", fmt.Errorf("tar entry escapes destination: %q", hdr.Name)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, fileModeFromTar(hdr.Mode))
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(out, tr); err != nil { //nolint:gosec // size bounded by trusted GitHub tarball
				// Surface (do not swallow) a close error on the copy-failure
				// path; a failed flush can itself signal data loss.
				if cerr := out.Close(); cerr != nil {
					return "", fmt.Errorf("write %s: %w (also failed to close: %v)", target, err, cerr)
				}
				return "", fmt.Errorf("write %s: %w", target, err)
			}
			if err := out.Close(); err != nil {
				return "", err
			}
		default:
			// Skip symlinks / special entries: the framework tree is regular
			// files + dirs, and skipping symlinks is an extra zip-slip defence.
			continue
		}
	}

	if rootName == "" {
		return "", fmt.Errorf("empty tarball: no entries")
	}
	contentRoot := filepath.Join(cleanDest, rootName)
	if info, err := os.Stat(contentRoot); err != nil || !info.IsDir() {
		return "", fmt.Errorf("tarball content root %q missing after extract", rootName)
	}
	return contentRoot, nil
}

// tarPathExcluded reports whether a split tar entry path should be skipped:
// any second-level component in the excluded set (top-level of the repo, under
// the wrapper dir) or any `.git` component anywhere in the path.
func tarPathExcluded(parts []string) bool {
	if len(parts) > 1 && tarballExcludedTopLevel[parts[1]] {
		return true
	}
	for _, seg := range parts[1:] {
		if seg == ".git" {
			return true
		}
	}
	return false
}

func fileModeFromTar(mode int64) os.FileMode {
	m := os.FileMode(mode).Perm()
	if m == 0 {
		m = 0o644
	}
	return m
}

// pathExists reports whether p exists. Wraps the os.Stat existence-check idiom
// so call sites read as a boolean predicate rather than a bare `err == nil`.
func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// shaFromContentRoot extracts the framework source SHA from the GitHub tarball
// wrapper dir name, which has the shape `<owner>-<repo>-<sha>` (e.g.
// `deftai-directive-6136b66...`). Returns "" when the trailing component is
// not a hex SHA.
func shaFromContentRoot(contentRoot string) string {
	base := filepath.Base(contentRoot)
	idx := strings.LastIndex(base, "-")
	if idx < 0 || idx == len(base)-1 {
		return ""
	}
	sha := base[idx+1:]
	if len(sha) < 7 || !isHex(sha) {
		return ""
	}
	return sha
}

func isHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return s != ""
}

// swapInCore atomically replaces coreDir with the freshly-extracted newTree,
// preserving the previous payload as a timestamped backup so the operation is
// reversible. The backup rename happens within coreDir's parent (same volume
// => atomic); the new tree is COPIED in because newTree typically lives on the
// temp volume and a cross-device rename would fail on Windows. On any failure
// after the backup the backup is restored. Returns the backup path on success.
func swapInCore(coreDir, newTree string) (string, error) {
	parent := filepath.Dir(coreDir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}

	backup := coreDir + ".bak-" + time.Now().UTC().Format("20060102-150405")
	if pathExists(backup) {
		// Sub-second reruns: disambiguate so we never clobber a prior backup.
		backup = fmt.Sprintf("%s-%d", backup, os.Getpid())
	}

	if err := os.Rename(coreDir, backup); err != nil {
		return "", fmt.Errorf("could not back up existing payload: %w", err)
	}

	if err := copyTree(newTree, coreDir); err != nil {
		// Roll back: discard the partial copy and restore the backup.
		os.RemoveAll(coreDir)
		if rerr := os.Rename(backup, coreDir); rerr != nil {
			return "", fmt.Errorf("install new payload failed (%v); ROLLBACK ALSO FAILED (%v) -- previous payload preserved at %s", err, rerr, backup)
		}
		return "", fmt.Errorf("install new payload: %w", err)
	}
	return backup, nil
}

// copyTree recursively copies the regular files and directories under src into
// dst (created if needed). Symlinks and special files are skipped. Directories
// are visited before their contents (filepath.WalkDir order) so each file's
// parent already exists by the time the shared copyFile (setup.go) runs.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			mode := os.FileMode(0o755)
			if info, ierr := d.Info(); ierr != nil {
				log.Printf("warning: stat dir entry %q for mode (using 0o755): %v", path, ierr)
			} else {
				mode = info.Mode().Perm()
			}
			return os.MkdirAll(target, mode)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		return copyFile(path, target)
	})
}

// tagFromRef returns ref when it looks like a semver release tag (so the
// VERSION manifest records `tag: 'vX.Y.Z'`), else "". Reuses semverTagPattern
// from main.go.
func tagFromRef(ref string) string {
	if semverTagPattern.MatchString(ref) {
		return ref
	}
	return ""
}

// refLabel renders a human-friendly label for a (possibly empty) ref.
func refLabel(ref string) string {
	if ref == "" {
		return "the repository default branch"
	}
	return ref
}

// samePath reports whether two paths refer to the same location, tolerant of
// symlinks, separator style (git prints POSIX slashes even on Windows), and
// Windows case-insensitivity.
func samePath(a, b string) bool {
	ca := canonicalPath(a)
	cb := canonicalPath(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

func canonicalPath(p string) string {
	p = filepath.FromSlash(strings.TrimSpace(p))
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	resolved, symErr := filepath.EvalSymlinks(abs)
	if symErr != nil {
		// The path may not exist yet (e.g. a not-yet-created core dir) -- fall
		// back to the lexically-cleaned absolute path. Not an error condition.
		return filepath.Clean(abs)
	}
	return resolved
}
