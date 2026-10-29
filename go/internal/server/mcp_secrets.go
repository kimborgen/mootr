package server

import (
	"errors"
	"log/slog"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// An MCP server's plain-text OAuth client secret moves into the secret store on the home daemon, and the reference
// {"secret": NAME} takes its place (src/settings.ts storeMcpSecrets, S-2736). Every settings write on the home runs
// through here, so a value typed on the MCP page, sent by settings_ask, or saved as the whole file never reaches
// settings.json. A store that refuses errors, so nothing is written. Logs name servers and store names, never values.

// storeMcpSecrets is servers with each plain client_secret stored and replaced by its reference; servers as they are
// on a non-home daemon or when they are no object.
func (s *Server) storeMcpSecrets(servers jsjson.Value) (jsjson.Value, error) {
	o, ok := servers.(*jsjson.Object)
	if !ok || o == nil || !s.isSettingsHome() {
		return servers, nil
	}
	out := jsjson.Clone(o).(*jsjson.Object)
	for _, server := range out.Keys() {
		v, _ := out.Get(server)
		a, _ := getValue(asObject(v), "auth").(*jsjson.Object)
		value, _ := getValue(a, "client_secret").(string)
		if value == "" {
			continue
		}
		ref, err := s.secrets.SetMcpClientSecret(server, value)
		if err != nil {
			return nil, secretsErr(err)
		}
		a.Set("client_secret", jsjson.NewObject("secret", ref))
	}
	return out, nil
}

// asObject is v as an object, nil when it is none.
func asObject(v jsjson.Value) *jsjson.Object {
	o, _ := v.(*jsjson.Object)
	return o
}

// storeMcpSecretsInPatch is a patch whose mcpServers have their plain client secrets stored: it replaces that key whole,
// so a secret the file already holds is left as it is. A fill patch changes only view records, so it stores nothing.
func (s *Server) storeMcpSecretsInPatch(patch *jsjson.Object, fill bool) (*jsjson.Object, error) {
	servers, ok := patch.Get("mcpServers")
	if !ok || fill {
		return patch, nil
	}
	stored, err := s.storeMcpSecrets(servers)
	if err != nil {
		return nil, err
	}
	out := jsjson.Clone(patch).(*jsjson.Object)
	out.Set("mcpServers", stored)
	return out, nil
}

// storeMcpSecretsInText is settings text with its MCP servers' plain client secrets stored: the text as it is when it
// holds none (or doesn't parse), else re-written with the references.
func (s *Server) storeMcpSecretsInText(text string) (string, error) {
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		return text, nil
	}
	user, ok := v.(*jsjson.Object)
	if !ok {
		return text, nil
	}
	servers, _ := user.Get("mcpServers")
	if asObject(servers) == nil {
		return text, nil
	}
	stored, err := s.storeMcpSecrets(servers)
	if err != nil {
		return "", err
	}
	if jsjson.Equal(stored, servers) {
		return text, nil
	}
	user.Set("mcpServers", stored)
	return jsjson.Stringify(user, "  ") + "\n", nil
}

// migrateClientSecrets is src/mcp-auth.ts migrateClientSecrets, run at start: the plain client secrets in the home's
// settings and in the token file move into the store, each under its server's name. A store name already holding
// another value is left alone, and a store that can't be read moves nothing. A second run finds only references.
func (s *Server) migrateClientSecrets() {
	move := func(server, value string) (string, bool) {
		name, ok := config.McpClientSecretName(server)
		if !ok {
			slog.Warn("mcp-auth: " + server + "'s client secret stays in settings: no store name fits it")
			return "", false
		}
		held, _, has, err := s.secrets.Stored(name)
		if err != nil {
			slog.Warn("mcp-auth: " + server + "'s client secret stays in place: " + err.Error())
			return "", false
		}
		if has && held.Reveal() != value {
			slog.Warn("mcp-auth: " + server + "'s client secret stays in place: " + name + " holds another value")
			return "", false
		}
		if !has {
			if _, err := s.secrets.SetMcpClientSecret(server, value); err != nil {
				slog.Warn("mcp-auth: " + server + "'s client secret stays in place: " + err.Error())
				return "", false
			}
			slog.Info("mcp-auth: moved " + server + "'s client secret into the secret store as " + name)
		}
		return name, true
	}
	if s.isSettingsHome() {
		err := s.settings.Update(func(file string) (string, error) {
			user := config.ParseObject(file)
			servers := asObject(getValue(user, "mcpServers"))
			if servers == nil {
				return "", errUnchanged
			}
			next := jsjson.Clone(servers).(*jsjson.Object)
			changed := false
			for _, server := range next.Keys() {
				a, _ := getValue(asObject(getValue(next, server)), "auth").(*jsjson.Object)
				value, _ := getValue(a, "client_secret").(string)
				if value == "" {
					continue
				}
				if ref, ok := move(server, value); ok {
					a.Set("client_secret", jsjson.NewObject("secret", ref))
					changed = true
				}
			}
			if !changed {
				return "", errUnchanged
			}
			user.Set("mcpServers", next)
			return jsjson.Stringify(user, "  ") + "\n", nil
		})
		switch {
		case err == nil:
			// Moving the secrets changes no permission mode, so nothing is logged for them.
			s.settingsWritten(s.settings.Get().PermissionModes, humanName)
		case !errors.Is(err, errUnchanged):
			slog.Warn("mcp-auth: the settings' client secrets stay in place: " + err.Error())
		}
	}
	if err := s.mcp.MoveClientSecrets(move); err != nil {
		slog.Warn("mcp-auth: the token file's client secrets stay in place: " + err.Error())
	}
}

// errUnchanged ends a settings update that has nothing to write.
var errUnchanged = errors.New("unchanged")
