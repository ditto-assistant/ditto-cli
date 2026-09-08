// Copy of the manifest structs from ditto-assistant/backend
// pkg/services/teleport/manifest.go (branch feat/teleport-capsules, e3130d965c54). The
// teleport contract test parses the json tags below and fails when the CLI
// manifest drifts from them; refresh this file whenever the backend changes.
package teleport

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/ditto-assistant/backend/pkg/services/filestorage"
)

// ManifestVersion is the manifest schema this service accepts.
const ManifestVersion = 1

// MaxChunkBytes is the largest chunk a manifest may reference (24 MiB): every
// storage provider buffers uploads in memory and caps them at 25 MiB.
const MaxChunkBytes = filestorage.MaxMirrorObjectBytes

// MaxManifestBytes bounds one manifest document.
const MaxManifestBytes = 8 << 20

// MaxChunksPerGeneration bounds the chunk list of one generation.
const MaxChunksPerGeneration = 50_000

var (
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	gitShaPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// Chunk is one content-addressed object.
type Chunk struct {
	Sha256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Remote is a git remote of a captured repository.
type Remote struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// Head is the checked-out commit of a captured repository.
type Head struct {
	Sha      string `json:"sha"`
	Branch   string `json:"branch,omitempty"`
	Upstream string `json:"upstream,omitempty"`
}

// Pack is one git bundle (pack + refs), full or thin against a parent generation.
type Pack struct {
	Kind            string  `json:"kind"`
	Chunks          []Chunk `json:"chunks"`
	BasisGeneration int32   `json:"basisGeneration,omitempty"`
}

// Worktree is the tar of modified and untracked files of one repository.
type Worktree struct {
	Chunks  []Chunk `json:"chunks"`
	Entries int     `json:"entries"`
	Bytes   int64   `json:"bytes"`
}

// Repo is one repository inside the capsule root.
type Repo struct {
	Head     Head     `json:"head"`
	RelPath  string   `json:"relPath"`
	Remotes  []Remote `json:"remotes"`
	Branches []string `json:"branches,omitempty"`
	// BranchUpstreams maps a local branch to its "<remote>/<branch>" upstream so a
	// restore can recreate tracking without a fetch; every remote named here must
	// appear in Remotes.
	BranchUpstreams map[string]string `json:"branchUpstreams,omitempty"`
	// UpstreamTips records the remote-tracking refs' real tips ("<remote>/<branch>"
	// -> 40-hex sha) so a restore recreates exactly them; restoring them from the
	// local tip would hide unpushed commits from the offload guard.
	UpstreamTips map[string]string `json:"upstreamTips,omitempty"`
	// Excludes are the effective exclude rules the capture applied, ProjectTypes
	// the detectors that fired ("node", "rust", …) and DittoConfig the digest of
	// the repo's Ditto configuration; all optional provenance for R1/R5.
	Excludes        []string         `json:"excludes,omitempty"`
	ProjectTypes    []string         `json:"projectTypes,omitempty"`
	DittoConfig     *RepoDittoConfig `json:"dittoConfig,omitempty"`
	Tags            []string         `json:"tags,omitempty"`
	Stashes         []string         `json:"stashes,omitempty"`
	Packs           []Pack           `json:"packs"`
	IgnoredIncludes []string         `json:"ignoredIncludes,omitempty"`
	Worktree        Worktree         `json:"worktree"`
}

// Harness is the coding harness's own session state (Claude Code JSONL,
// Codex rollout) captured with the capsule.
type Harness struct {
	Kind      string  `json:"kind"`
	SessionID string  `json:"sessionId,omitempty"`
	Cwd       string  `json:"cwd,omitempty"`
	Chunks    []Chunk `json:"chunks"`
}

// Root describes the capsule root.
type Root struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// Totals are the manifest's own byte accounting; the server recomputes them.
type Totals struct {
	Chunks       int   `json:"chunks"`
	Bytes        int64 `json:"bytes"`
	DedupedBytes int64 `json:"dedupedBytes,omitempty"`
}

// Manifest is one generation of a capsule.
type Manifest struct {
	CreatedAt        time.Time      `json:"createdAt"`
	Machine          map[string]any `json:"machine"`
	CapsuleID        string         `json:"capsuleId"`
	Root             Root           `json:"root"`
	Repos            []Repo         `json:"repos"`
	Excludes         []string       `json:"excludes,omitempty"`
	Harness          Harness        `json:"harness"`
	Totals           Totals         `json:"totals"`
	Version          int            `json:"v"`
	Generation       int32          `json:"generation"`
	ParentGeneration int32          `json:"parentGeneration"`
}

// ErrInvalidManifest wraps every manifest validation failure.
var ErrInvalidManifest = errors.New("invalid teleport manifest")

// ParseManifest decodes and validates a manifest document.
func ParseManifest(raw []byte) (*Manifest, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("%w: empty", ErrInvalidManifest)
	}
	if len(raw) > MaxManifestBytes {
		return nil, fmt.Errorf("%w: manifest exceeds %d bytes", ErrInvalidManifest, MaxManifestBytes)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidManifest, err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate checks the manifest's structure and chunk references.
func (m *Manifest) Validate() error {
	if m.Version != ManifestVersion {
		return fmt.Errorf("%w: unsupported version %d", ErrInvalidManifest, m.Version)
	}
	if m.Generation <= 0 {
		return fmt.Errorf("%w: generation must be positive", ErrInvalidManifest)
	}
	if m.ParentGeneration != m.Generation-1 {
		return fmt.Errorf("%w: parentGeneration must be generation-1", ErrInvalidManifest)
	}
	switch m.Root.Kind {
	case "repo", "folder":
	default:
		return fmt.Errorf("%w: root.kind must be repo or folder", ErrInvalidManifest)
	}
	if strings.TrimSpace(m.Root.Name) == "" {
		return fmt.Errorf("%w: root.name is required", ErrInvalidManifest)
	}
	if len(m.Repos) == 0 && len(m.Harness.Chunks) == 0 {
		return fmt.Errorf("%w: a generation must carry at least one repo or harness state", ErrInvalidManifest)
	}
	for i, r := range m.Repos {
		if r.RelPath == "" || strings.HasPrefix(r.RelPath, "/") || strings.Contains(r.RelPath, "..") {
			return fmt.Errorf("%w: repos[%d].relPath must be a relative path inside the root", ErrInvalidManifest, i)
		}
		if err := r.validateUpstreams(i); err != nil {
			return err
		}
		if err := r.validateProvenance(i); err != nil {
			return err
		}
		for j, p := range r.Packs {
			if p.Kind != "full" && p.Kind != "thin" {
				return fmt.Errorf("%w: repos[%d].packs[%d].kind must be full or thin", ErrInvalidManifest, i, j)
			}
			if p.Kind == "thin" && (p.BasisGeneration <= 0 || p.BasisGeneration >= m.Generation) {
				return fmt.Errorf("%w: repos[%d].packs[%d] thin pack needs an earlier basisGeneration", ErrInvalidManifest, i, j)
			}
		}
	}
	switch m.Harness.Kind {
	case "", "none", "claude-code", "codex":
	default:
		return fmt.Errorf("%w: unknown harness kind %q", ErrInvalidManifest, m.Harness.Kind)
	}
	chunks := m.Chunks()
	if len(chunks) == 0 {
		return fmt.Errorf("%w: no chunks", ErrInvalidManifest)
	}
	if len(chunks) > MaxChunksPerGeneration {
		return fmt.Errorf("%w: %d chunks exceeds %d", ErrInvalidManifest, len(chunks), MaxChunksPerGeneration)
	}
	for _, c := range chunks {
		if err := c.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// validateUpstreams checks that every recorded upstream is "<remote>/<branch>"
// for a remote the repo actually carries.
// RepoDittoConfig records which Ditto configuration a capture saw: its
// version, the sha256 of the effective config and the files it came from.
type RepoDittoConfig struct {
	Digest  string   `json:"digest"`
	Sources []string `json:"sources,omitempty"`
	Version int      `json:"version"`
}

// maxProvenanceEntries bounds each provenance list; captures list rules and
// detectors, not file trees.
const maxProvenanceEntries = 256

// validateProvenance checks the optional capture provenance: non-empty
// strings, bounded lists, and a 64-hex config digest.
func (r Repo) validateProvenance(i int) error {
	if err := validateStringList("excludes", r.Excludes, i); err != nil {
		return err
	}
	if err := validateStringList("projectTypes", r.ProjectTypes, i); err != nil {
		return err
	}
	if r.DittoConfig == nil {
		return nil
	}
	if r.DittoConfig.Version < 0 {
		return fmt.Errorf("%w: repos[%d].dittoConfig.version must not be negative", ErrInvalidManifest, i)
	}
	if !sha256Pattern.MatchString(r.DittoConfig.Digest) {
		return fmt.Errorf("%w: repos[%d].dittoConfig.digest must be 64 lowercase hex characters", ErrInvalidManifest, i)
	}
	return validateStringList("dittoConfig.sources", r.DittoConfig.Sources, i)
}

func validateStringList(field string, values []string, i int) error {
	if len(values) > maxProvenanceEntries {
		return fmt.Errorf("%w: repos[%d].%s has %d entries; at most %d", ErrInvalidManifest, i, field, len(values), maxProvenanceEntries)
	}
	for _, v := range values {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("%w: repos[%d].%s contains an empty entry", ErrInvalidManifest, i, field)
		}
	}
	return nil
}

func (r Repo) validateUpstreams(i int) error {
	if len(r.BranchUpstreams) == 0 && len(r.UpstreamTips) == 0 {
		return nil
	}
	remotes := make(map[string]struct{}, len(r.Remotes))
	for _, rem := range r.Remotes {
		remotes[rem.Name] = struct{}{}
	}
	for branch, upstream := range r.BranchUpstreams {
		if strings.TrimSpace(branch) == "" {
			return fmt.Errorf("%w: repos[%d].branchUpstreams has an empty branch name", ErrInvalidManifest, i)
		}
		remote, ref, ok := strings.Cut(upstream, "/")
		if !ok || remote == "" || ref == "" {
			return fmt.Errorf("%w: repos[%d].branchUpstreams[%q] must be <remote>/<branch>", ErrInvalidManifest, i, branch)
		}
		if _, known := remotes[remote]; !known {
			return fmt.Errorf("%w: repos[%d].branchUpstreams[%q] names unknown remote %q", ErrInvalidManifest, i, branch, remote)
		}
	}
	for ref, sha := range r.UpstreamTips {
		remote, branch, ok := strings.Cut(ref, "/")
		if !ok || strings.TrimSpace(remote) == "" || strings.TrimSpace(branch) == "" {
			return fmt.Errorf("%w: repos[%d].upstreamTips key %q must be <remote>/<branch>", ErrInvalidManifest, i, ref)
		}
		if _, known := remotes[remote]; !known {
			return fmt.Errorf("%w: repos[%d].upstreamTips key %q names unknown remote %q", ErrInvalidManifest, i, ref, remote)
		}
		if !gitShaPattern.MatchString(sha) {
			return fmt.Errorf("%w: repos[%d].upstreamTips[%q] %q is not a 40-hex lowercase sha", ErrInvalidManifest, i, ref, sha)
		}
	}
	return nil
}

// Validate checks one chunk reference.
func (c Chunk) Validate() error {
	if !sha256Pattern.MatchString(c.Sha256) {
		return fmt.Errorf("%w: chunk sha256 %q is not 64 lowercase hex characters", ErrInvalidManifest, c.Sha256)
	}
	if c.Size <= 0 || c.Size > MaxChunkBytes {
		return fmt.Errorf("%w: chunk %s size %d must be within 1..%d", ErrInvalidManifest, c.Sha256[:12], c.Size, MaxChunkBytes)
	}
	return nil
}

// Chunks returns every distinct chunk the manifest references, in first-seen
// order (packs, then worktrees, then harness state).
func (m *Manifest) Chunks() []Chunk {
	seen := make(map[string]struct{})
	var out []Chunk
	add := func(list []Chunk) {
		for _, c := range list {
			if _, ok := seen[c.Sha256]; ok {
				continue
			}
			seen[c.Sha256] = struct{}{}
			out = append(out, c)
		}
	}
	for _, r := range m.Repos {
		for _, p := range r.Packs {
			add(p.Chunks)
		}
		add(r.Worktree.Chunks)
	}
	add(m.Harness.Chunks)
	return out
}

// Bytes is the sum of the sizes of the manifest's distinct chunks.
func (m *Manifest) Bytes() int64 {
	var total int64
	for _, c := range m.Chunks() {
		total += c.Size
	}
	return total
}

// Sha256Hex returns the lowercase hex sha256 of b.
func Sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ChunkKey is the object key of a chunk: user-scoped so the provider's
// delete-by-user-prefix cleanup covers it, content-addressed so identical bytes
// across capsules and generations share one object.
func ChunkKey(userID, sha string) string {
	return strings.TrimSpace(userID) + "/teleport/" + strings.ToLower(strings.TrimSpace(sha))
}
