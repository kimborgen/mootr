package server

import "regexp"

// The per-agent routes whose auth decision src/daemon.ts takes before a request is relayed (src/agent-routes.ts
// AGENT_ROUTES, S-1900): the `acting` ones run mayActAs on the agent in the path, and the OpenCode server's request to an
// `opencodeNamed` route needs no `by`, `from` or `self` in its body. TestAgentRoutesMatchTS compares both lists with the
// table in TS.

type agentRoute struct {
	method string
	re     *regexp.Regexp
}

func agentRoutes(method string, paths ...string) []agentRoute {
	var out []agentRoute
	for _, p := range paths {
		out = append(out, agentRoute{method, regexp.MustCompile(`^/api/agents/([\w-]+)` + p + `$`)})
	}
	return out
}

var (
	// actingRoutes is the routes with auth `acting`.
	actingRoutes = append(
		agentRoutes("GET", `/files`, `/instructions`, `/inventory`, `/inbox`, `/threads`, `/thread-index`, `/view`, `/view/history`, `/view/tools`, `/stream`, `/events`),
		agentRoutes("POST", `/threads/([\w-]+)/(archive|unarchive|defer|undefer)`, `/read`, `/waits`, `/waits/clear`, `/waits/declared`, `/waits/wake`, `/waits/done`)...)
	// opencodeNamedRoutes is the routes whose path names the agent for the OpenCode server: `acting` ones, except POST
	// /waits (mayManageWaits reads a missing `by` as the human), and POST /workspace-share, which is `self`.
	opencodeNamedRoutes = append(
		agentRoutes("GET", `/files`, `/instructions`, `/inventory`, `/inbox`, `/threads`, `/thread-index`, `/view`, `/view/history`, `/view/tools`, `/stream`, `/events`),
		agentRoutes("POST", `/threads/([\w-]+)/(archive|unarchive|defer|undefer)`, `/read`, `/waits/clear`, `/waits/declared`, `/waits/wake`, `/waits/done`, `/workspace-share`)...)
)

// matchActing is src/agent-routes.ts matchActing: the agent in the path of a request mayActAs checks before the relay, or "".
func matchActing(method, path string) (string, bool) {
	for _, r := range actingRoutes {
		if r.method == method {
			if m := r.re.FindStringSubmatch(path); m != nil {
				return m[1], true
			}
		}
	}
	return "", false
}

// opencodeNamesAgent is src/agent-routes.ts opencodeNamesAgent.
func opencodeNamesAgent(method, path string) bool {
	for _, r := range opencodeNamedRoutes {
		if r.method == method && r.re.MatchString(path) {
			return true
		}
	}
	return false
}
