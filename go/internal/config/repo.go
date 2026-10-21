package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// DerivedRepoPath is src/default-repo.ts derivedRepoPath: the checkout stam runs from, "" when root is neither a release nor a git
// checkout. A release records its source in .release.json (`repo`); a checkout is its own.
func DerivedRepoPath(root string) string {
	if b, err := os.ReadFile(filepath.Join(root, ".release.json")); err == nil {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil {
			if repo, ok := m["repo"].(string); ok && repo != "" {
				return canonical(repo)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err == nil {
		return canonical(root)
	}
	return ""
}

// DerivedRepos is src/default-repo.ts derivedRepos: the default repo as {name: path}, keyed by the checkout's directory name.
func DerivedRepos(root string) map[string]string {
	if p := DerivedRepoPath(root); p != "" {
		return map[string]string{filepath.Base(p): p}
	}
	return map[string]string{}
}

// DeployCheckout is src/workspace.ts deployCheckout: the repo the deploy watcher deploys from. STAM_DEPLOY_REPO names it; else the
// release source of root (a checkout is its own); else ~/projects/stam2.
func DeployCheckout(deployRepo, root string) string {
	if deployRepo != "" {
		if abs, err := filepath.Abs(deployRepo); err == nil {
			return abs
		}
		return deployRepo
	}
	if p := DerivedRepoPath(root); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "projects", "stam2")
}

func canonical(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}
