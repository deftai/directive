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

// Install/upgrade strategies surfaced in --json diagnostics. Every payload the
// installer deposits is now git-free (#1428 "vendored-done-right"): a fresh
// install vendors a tarball, an existing vendored payload is refreshed via file
// swap, and a legacy git-clone payload is migrated to vendored.
const (
	strategyFileSwap = "file-swap"
	strategyVendor   = "vendor"
	strategyMigrate  = "clone-to-vendored"
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

// tarballExcludedRepoPrefixes are repo-relative content prefixes that should
// not be deposited into consumer .deft/core payloads. These are source-repo
// forensic/project-management artifacts, not runtime framework files.
var tarballExcludedRepoPrefixes = []string{
	"history/archive",
	"vbrief/completed",
	"vbrief/cancelled",
}

// UpdateOutcome reports what the update path did so main.go can populate the
// --json diagnostics (payload_layout / strategy) and re-stamp the VERSION
// manifest with the framework source SHA resolved from the tarball rather than
// the parent consumer repo's HEAD (the #1323/#1324 wrong-sha class).
type UpdateOutcome struct {
	Layout   string // clone | vendored | absent
	Strategy string // file-swap | vendor | clone-to-vendored
	SHA      string // framework source SHA (best-effort)
	Tag      string // resolved release tag, when the ref looked like semver
	Backup   string // path to the pre-swap backup of <core>, when a swap ran
}

// runGitCaptureFunc runs `git -C dir args...` and returns trimmed stdout.
// Indirected through a var so tests can stub git without a real repo. ONLY
// read-only git subcommands are ever routed through this helper (it is used
// solely by classifyPayloadLayout to read `git rev-parse --show-toplevel`).
// No installer code path runs a mutating git command against the payload or
// the parent consumer repo (#1428 safety guardrail).
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
// that layout. Every strategy is now git-free against the consumer repo (#1428
// "vendored-done-right"):
//
//   - clone    -> migrate to vendored (download tarball, atomic swap, drop the
//     nested .git). This removes the #1425 mutating-git surface and fixes the
//     detached-HEAD `git pull` failure on tag clones.
//   - vendored -> git-free file swap (download tarball, atomic replace).
//   - absent   -> fresh git-free vendor (treat --upgrade on a missing payload
//     as a vendor install).
//
// The hard guardrail is structural: no branch runs a mutating git command
// against the payload or the parent consumer repo.
func UpdateDeft(w *Wizard, result *WizardResult, branch string) (*UpdateOutcome, error) {
	switch classifyPayloadLayout(result.DeftDir) {
	case payloadLayoutClone:
		return migrateCloneToVendored(w, result, branch)
	case payloadLayoutVendored:
		return refreshVendoredCore(w, result, branch)
	default: // absent -- treat --upgrade on a missing payload as a fresh vendor.
		w.printf("No framework payload found at %s; vendoring a fresh copy ...\n", result.DeftDir)
		return VendorDeft(w, result, branch)
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

// VendorDeft performs a fresh, git-free vendor install of the framework: it
// downloads the release tarball at ref, extracts it (excluding
// .git/.github/node_modules), and deposits the tree at <core> with NO git
// metadata of its own (#1428). This replaces the historical `git clone`
// install so a fresh deposit can never (a) leave a nested .deft/core/.git that
// re-introduces the #1425 mutating-git surface, nor (b) hit the detached-HEAD
// `git pull` failure a tag clone produces on the next upgrade.
//
// On a greenfield project <core> does not exist yet, so the extracted tree is
// copied straight in. If a stray payload is already present it is swapped in
// with a timestamped backup for safety/idempotency. The framework source SHA
// recovered from the tarball wrapper is reported so the caller can stamp true
// framework provenance into the VERSION manifest (the #1323/#1324 wrong-sha
// class).
func VendorDeft(w *Wizard, result *WizardResult, branch string) (*UpdateOutcome, error) {
	outcome := &UpdateOutcome{
		Layout:   payloadLayoutVendored,
		Strategy: strategyVendor,
		Tag:      tagFromRef(branch),
	}
	if err := os.MkdirAll(result.ProjectDir, 0o755); err != nil {
		return outcome, fmt.Errorf("vendor install: could not create project directory: %w", err)
	}
	w.printf("Vendoring deft into %s (git-free tarball install) ...\n", result.DeftDir)

	contentRoot, sha, cleanup, err := downloadAndExtractCore(branch)
	if err != nil {
		return outcome, fmt.Errorf("vendor install: %w", err)
	}
	defer cleanup()
	if sha != "" {
		outcome.SHA = sha
	}

	if pathExists(result.DeftDir) {
		// A previous payload is present (re-run / stray dir): swap it out with a
		// timestamped backup rather than merging the new tree into the old one.
		backup, swErr := swapInCore(result.DeftDir, contentRoot)
		if swErr != nil {
			return outcome, fmt.Errorf("vendor install: %w", swErr)
		}
		outcome.Backup = backup
	} else {
		if err := os.MkdirAll(filepath.Dir(result.DeftDir), 0o755); err != nil {
			return outcome, fmt.Errorf("vendor install: could not create framework parent dir: %w", err)
		}
		if err := copyTree(contentRoot, result.DeftDir); err != nil {
			return outcome, fmt.Errorf("vendor install: %w", err)
		}
	}

	w.printf("Deft vendored at %s.\n", result.DeftDir)
	return outcome, nil
}

// migrateCloneToVendored converts a legacy git-clone payload into a vendored
// (git-free) payload WITHOUT running any git command (#1428). It downloads the
// release tarball, atomically swaps it in over <core> with a timestamped
// backup of the old clone, then removes any nested .git so the next --upgrade
// classifies the payload as vendored (not clone). This fixes the live
// detached-HEAD `git pull` failure on tag clones the previous git
// fetch/checkout/pull path hit, and removes the #1425 mutating-git surface.
func migrateCloneToVendored(w *Wizard, result *WizardResult, branch string) (*UpdateOutcome, error) {
	outcome := &UpdateOutcome{
		Layout:   payloadLayoutVendored, // POST-migration layout (#1426 report-resulting-state precedent)
		Strategy: strategyMigrate,
		Tag:      tagFromRef(branch),
	}
	w.printf("Detected a git-clone framework payload at %s; migrating to a vendored (git-free) payload ...\n", result.DeftDir)

	contentRoot, sha, cleanup, err := downloadAndExtractCore(branch)
	if err != nil {
		return outcome, fmt.Errorf("clone->vendored migration: %w", err)
	}
	defer cleanup()
	if sha != "" {
		outcome.SHA = sha
	}

	backup, err := swapInCore(result.DeftDir, contentRoot)
	if err != nil {
		return outcome, fmt.Errorf("clone->vendored migration: %w", err)
	}
	outcome.Backup = backup

	// Defensive: extractCoreTarball already excludes .git, so the swapped-in
	// tree carries none -- but a nested .deft/core/.git left by any other rail
	// would re-trigger the clone classification (and the #1425 safety bug) on
	// the next run, so remove it explicitly.
	if gitDir := filepath.Join(result.DeftDir, ".git"); pathExists(gitDir) {
		if rmErr := os.RemoveAll(gitDir); rmErr != nil {
			w.printf("warning: migrated payload but could not remove nested .git at %s: %v\n", gitDir, rmErr)
		}
	}

	w.printf("Framework payload migrated to vendored at %s (previous clone backed up at %s).\n", result.DeftDir, backup)
	return outcome, nil
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

	contentRoot, sha, cleanup, err := downloadAndExtractCore(branch)
	if err != nil {
		return outcome, fmt.Errorf("vendored refresh: %w", err)
	}
	defer cleanup()
	if sha != "" {
		outcome.SHA = sha
	}

	backup, err := swapInCore(result.DeftDir, contentRoot)
	if err != nil {
		return outcome, fmt.Errorf("vendored refresh: %w", err)
	}
	outcome.Backup = backup

	// #1437: the vendored file-swap owns .deft/core/** only. Regenerate the
	// bare vbrief/.deft-version derivative from the resolved release tag -- the
	// same tag the caller stamps into .deft/core/VERSION -- so the upgrade
	// leaves the install self-consistent. Without this a stale derivative left
	// by an earlier rail (e.g. "0.0.0-dev") fails the doctor's manifest-
	// agreement check. Best-effort: a write failure warns but never fails the
	// refresh.
	if marker, mErr := regenerateBareVersionMarker(result.ProjectDir, outcome.Tag); mErr != nil {
		w.printf("warning: refreshed payload but could not regenerate vbrief/.deft-version: %v\n", mErr)
	} else if marker != "" {
		w.printf("Regenerated %s to %s (agrees with the refreshed manifest).\n", marker, bareVersionFromTag(outcome.Tag))
	}

	w.printf("Vendored framework refreshed at %s (previous payload backed up at %s).\n", result.DeftDir, backup)
	return outcome, nil
}

// bareVersionFromTag converts a manifest tag/ref ("v0.39.3" or "0.39.3") to the
// bare vbrief/.deft-version derivative value ("0.39.3") by stripping a single
// leading "v". Mirrors run::_install_manifest_tag_to_version and the doctor's
// _manifest_tag_to_version (which lstrip("v") before comparing). Returns "" for
// an empty tag so callers skip writing a meaningless derivative (e.g. a branch
// upgrade whose manifest carries no semver tag).
func bareVersionFromTag(tag string) string {
	t := strings.TrimSpace(tag)
	if t == "" {
		return ""
	}
	return strings.TrimPrefix(t, "v")
}

// regenerateBareVersionMarker (re)writes the bare vbrief/.deft-version
// derivative from the resolved release tag so it agrees with the canonical
// <core>/VERSION manifest the installer stamps after a vendored swap (#1437).
// The file holds the BARE semver plus a trailing newline, mirroring
// run::_write_version_marker and the doctor's preferred bare-derivative
// location (vbrief/.deft-version). Returns the written path, or "" when tag
// carries no semver (nothing to regenerate). The parent vbrief/ directory is
// created if absent.
func regenerateBareVersionMarker(projectDir, tag string) (string, error) {
	bare := bareVersionFromTag(tag)
	if bare == "" {
		return "", nil
	}
	vbriefDir := filepath.Join(projectDir, "vbrief")
	if err := os.MkdirAll(vbriefDir, 0o755); err != nil {
		return "", fmt.Errorf("could not create vbrief/ for .deft-version: %w", err)
	}
	path := filepath.Join(vbriefDir, ".deft-version")
	if err := os.WriteFile(path, []byte(bare+"\n"), 0o644); err != nil {
		return "", fmt.Errorf("could not write vbrief/.deft-version: %w", err)
	}
	return path, nil
}

// downloadAndExtractCore downloads the framework source tarball at ref (empty
// => default branch) and extracts it into a fresh temp staging dir, returning
// the extracted content root, the framework source SHA recovered from the
// tarball wrapper (best-effort, may be ""), and a cleanup func the caller MUST
// defer to remove the tarball + staging dir. On error the cleanup has already
// run and a no-op func is returned so callers can defer unconditionally.
func downloadAndExtractCore(ref string) (contentRoot, sha string, cleanup func(), err error) {
	noop := func() {}
	tarballPath, err := fetchCoreTarballFunc(ref)
	if err != nil {
		return "", "", noop, fmt.Errorf("could not download the release tarball for %s: %w", refLabel(ref), err)
	}
	staging, err := os.MkdirTemp("", "deft-core-stage-*")
	if err != nil {
		os.Remove(tarballPath)
		return "", "", noop, fmt.Errorf("could not create staging dir: %w", err)
	}
	cleanup = func() {
		os.Remove(tarballPath)
		os.RemoveAll(staging)
	}
	root, err := extractCoreTarball(tarballPath, staging)
	if err != nil {
		cleanup()
		return "", "", noop, fmt.Errorf("could not extract tarball: %w", err)
	}
	return root, shaFromContentRoot(root), cleanup, nil
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

		// zip-slip / CodeQL go/zipslip: sanitize the RAW archive entry name --
		// the taint source from tr.Next() -- before any filesystem path is
		// derived from it. strings.Contains(hdr.Name, "..") on the original
		// header name is the barrier shape CodeQL's go/zipslip model recognises,
		// and rejecting at the source cuts every downstream MkdirAll / OpenFile
		// path. GitHub source tarballs never contain ".." entries, so this is a
		// no-op for valid input.
		if strings.Contains(hdr.Name, "..") {
			return "", fmt.Errorf("tar entry contains a '..' path element: %q", hdr.Name)
		}

		name := strings.TrimPrefix(filepath.ToSlash(hdr.Name), "./")
		if name == "" {
			continue
		}
		parts := strings.Split(name, "/")
		// GitHub source tarballs lead with a `pax_global_header` global-PAX
		// record (and may carry per-entry extended headers). These are tar
		// metadata, not content: skip them entirely so the wrapper directory --
		// not "pax_global_header" -- is captured as the content root (#1433).
		if hdr.Typeflag == tar.TypeXGlobalHeader || hdr.Typeflag == tar.TypeXHeader {
			continue
		}
		if rootName == "" {
			rootName = parts[0]
		}
		if tarPathExcluded(parts) {
			continue
		}

		// filepath.Join cleans its result, so target is already lexically clean;
		// validate THAT exact value (not a separate filepath.Clean copy) so the
		// checked path is the one that flows into the MkdirAll / OpenFile sinks
		// below -- the containment barrier CodeQL go/zipslip recognises.
		target := filepath.Join(cleanDest, filepath.FromSlash(name))
		if !strings.HasPrefix(target, cleanDest+string(os.PathSeparator)) {
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
	if len(parts) > 1 {
		repoRel := strings.Join(parts[1:], "/")
		for _, prefix := range tarballExcludedRepoPrefixes {
			if repoRel == prefix || strings.HasPrefix(repoRel, prefix+"/") {
				return true
			}
		}
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

// swapInCore replaces coreDir with the freshly-extracted newTree, preserving
// the previous payload as a timestamped backup so the operation is reversible.
//
// #1445: the backup is staged OUTSIDE the consumer working tree (under the
// user cache dir, OS temp as a fallback) rather than at the in-tree
// `<coreDir>.bak-<ts>` it used to use. An in-tree backup escaped the
// `.deft/core/`-only gitignore policy (consumers commit .deft/core/ for
// reproducibility, so .deft/ is NOT blanket-ignored) and was trapped by
// `git add -A`, staging thousands of backup files. Writing it out-of-tree
// means the upgrade never leaves an untracked artefact in the repo.
//
// The previous payload is MOVED to the backup via movePayload, which is
// cross-device-safe (rename when same-volume, copy+remove otherwise -- the
// usual case for a cache/temp backup). The new tree is then COPIED in. On any
// failure after the backup the previous payload is restored from it. Returns
// the (out-of-tree) backup path on success so the caller can print it for
// rollback discoverability.
func swapInCore(coreDir, newTree string) (string, error) {
	parent := filepath.Dir(coreDir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}

	backup, err := backupDirOutsideTree()
	if err != nil {
		return "", fmt.Errorf("could not allocate out-of-tree backup dir: %w", err)
	}

	if err := movePayload(coreDir, backup); err != nil {
		return "", fmt.Errorf("could not back up existing payload: %w", err)
	}

	if err := copyTree(newTree, coreDir); err != nil {
		// Roll back: discard the partial copy and restore from the backup.
		os.RemoveAll(coreDir)
		if rerr := movePayload(backup, coreDir); rerr != nil {
			return "", fmt.Errorf("install new payload failed (%v); ROLLBACK ALSO FAILED (%v) -- previous payload preserved at %s", err, rerr, backup)
		}
		return "", fmt.Errorf("install new payload: %w", err)
	}
	return backup, nil
}

// backupRootDirFunc resolves the base directory under which swapInCore stages
// the out-of-tree payload backup (#1445). Indirected through a var so tests
// can redirect it to a hermetic temp dir instead of polluting the real user
// cache dir.
var backupRootDirFunc = defaultBackupRootDir

// defaultBackupRootDir returns ``<user-cache>/deft/backups`` (e.g.
// ``%LocalAppData%\deft\backups`` on Windows, ``~/.cache/deft/backups`` on
// Linux), falling back to the OS temp dir when the user cache dir cannot be
// resolved. The directory is created on demand by backupDirOutsideTree.
func defaultBackupRootDir() string {
	base, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(base) == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "deft", "backups")
}

// backupDirOutsideTree returns a not-yet-existing directory path -- OUTSIDE the
// consumer working tree -- where swapInCore stages the pre-swap payload backup
// (#1445). The path is timestamped and pid-disambiguated for sub-second
// reruns. The parent backup root is created here; if the resolved root is not
// writable the OS temp dir is used as a last resort.
func backupDirOutsideTree() (string, error) {
	dir := backupRootDirFunc()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		dir = filepath.Join(os.TempDir(), "deft-backups")
		if err2 := os.MkdirAll(dir, 0o755); err2 != nil {
			return "", err2
		}
	}
	backup := filepath.Join(dir, "core.bak-"+time.Now().UTC().Format("20060102-150405"))
	if pathExists(backup) {
		backup = fmt.Sprintf("%s-%d", backup, os.Getpid())
	}
	return backup, nil
}

// movePayload moves src to dst, tolerant of a cross-device boundary. It tries
// an atomic os.Rename first (fast, same-volume); when that fails -- the usual
// case when dst lives on the OS cache/temp volume, where os.Rename returns
// EXDEV/ERROR_NOT_SAME_DEVICE -- it falls back to a recursive copy followed by
// removing the source. The destination parent is created on demand. On the
// copy-fallback path the source is left intact if the copy fails, so a
// caller's rollback message can still point at a preserved backup.
func movePayload(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyTree(src, dst); err != nil {
		return err
	}
	return os.RemoveAll(src)
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
