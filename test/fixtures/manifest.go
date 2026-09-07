// Copy of the manifest structs from ditto-assistant/backend
// pkg/services/teleport/manifest.go (branch feat/teleport-capsules). The
// teleport contract test parses the json tags below and fails when the CLI
// manifest drifts from them; refresh this file whenever the backend changes.
package teleport

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
	Head            Head     `json:"head"`
	RelPath         string   `json:"relPath"`
	Remotes         []Remote `json:"remotes"`
	Branches        []string `json:"branches,omitempty"`
	Tags            []string `json:"tags,omitempty"`
	Stashes         []string `json:"stashes,omitempty"`
	Packs           []Pack   `json:"packs"`
	IgnoredIncludes []string `json:"ignoredIncludes,omitempty"`
	Worktree        Worktree `json:"worktree"`
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

