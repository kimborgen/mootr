package opencode

import "stam/internal/jsjson"

// errorClasses maps OpenCode's provider error types to the cost policy's classes (src/adapters/opencode.ts
// OPENCODE_ERROR_CLASS, verified on OpenCode v2.0.26): 402 is provider.quota, 429 provider.rate-limit, 401 and 403
// provider.auth, and network or 5xx errors the transient ones.
var errorClasses = map[string]string{
	"provider.rate-limit": "limit",
	"provider.quota":      "credits",
	"provider.auth":       "auth",
	"provider.transport":  "transient",
	"provider.connect":    "transient",
	"provider.internal":   "transient",
	"provider.timeout":    "transient",
}

// KnownErrorType is whether t is one of the provider error types errorClasses names: the only error text from the server
// stam keeps.
func KnownErrorType(t string) bool {
	_, ok := errorClasses[t]
	return ok
}

// permissionActions are the permissions OpenCode v2 asks for (its tools' names, as its binary spells them): the only
// actions of a permission.asked stam keeps.
var permissionActions = map[string]bool{
	"read": true, "edit": true, "shell": true, "bash": true, "glob": true, "grep": true, "list": true, "lsp": true,
	"task": true, "skill": true, "todoread": true, "todowrite": true, "webfetch": true, "websearch": true,
	"codesearch": true, "external_directory": true, "doom_loop": true, "question": true,
}

// KnownPermissionAction is whether a is one of the permissions OpenCode asks for (permissionActions).
func KnownPermissionAction(a string) bool { return permissionActions[a] }

// ClassifyError is src/adapters/opencode.ts classifyOpenCodeError: a `session.execution.failed` event's error as a cost
// class, by its type, else by its API status; "" for any other event, or an error neither names.
func ClassifyError(payload jsjson.Value) string {
	o, _ := payload.(*jsjson.Object)
	if t, _ := o.Get("type"); t != "session.execution.failed" {
		return ""
	}
	data, _ := o.Get("data")
	dobj, _ := data.(*jsjson.Object)
	errv, _ := dobj.Get("error")
	if errv == nil {
		errv, _ = o.Get("error")
	}
	if !jsjson.Truthy(errv) {
		return ""
	}
	eobj, _ := errv.(*jsjson.Object)
	t, _ := eobj.Get("type")
	if c, ok := errorClasses[jsjson.ToString(t)]; ok {
		return c
	}
	status, _ := eobj.Get("status")
	return statusClass(status)
}

// statusClass is src/adapters/opencode.ts opencodeStatusClass.
func statusClass(status jsjson.Value) string {
	s, ok := status.(float64)
	switch {
	case !ok:
		return ""
	case s == 402:
		return "credits"
	case s == 429:
		return "limit"
	case s == 401 || s == 403:
		return "auth"
	case s == 408 || s == 409 || s >= 500:
		return "transient"
	}
	return ""
}
