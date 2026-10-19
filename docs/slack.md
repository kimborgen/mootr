# Slack for mootr

mootr reaches Slack's MCP server (`https://mcp.slack.com/mcp`) with a login through a Slack app you make, so agents can read and post as you. Slack's server only accepts internal apps and directory-published apps, so a Slack app is needed either way.

## 1. Create the Slack app

1. Open https://api.slack.com/apps and choose **Create New App**, then **From an app manifest**. Pick your workspace.
2. Paste this YAML, replacing `YOUR-TAILNET-HOST` with the host you open mootr's web UI on (for example `stam.example.com`).
3. Create the app, then **Install to Workspace** and allow it.

```yaml
display_information:
  name: stam
features:
  bot_user:
    display_name: stam
    always_online: false
oauth_config:
  redirect_urls:
    - https://YOUR-TAILNET-HOST/oauth/callback
  scopes:
    user:
      - canvases:read
      - canvases:write
      - channels:history
      - channels:read
      - channels:write
      - chat:write
      - emoji:read
      - files:read
      - files:write
      - groups:history
      - groups:read
      - groups:write
      - im:history
      - im:read
      - im:write
      - lists:read
      - lists:write
      - mpim:history
      - mpim:read
      - mpim:write
      - reactions:read
      - reactions:write
      - search:read.files
      - search:read.im
      - search:read.mpim
      - search:read.private
      - search:read.public
      - search:read.users
      - users:read
      - users:read.email
settings:
  org_deployed: false
  socket_mode_enabled: false
  token_rotation_enabled: true
```

The redirect URL is the web UI's address followed by `/oauth/callback`. mootr's login returns there after Slack asks you to allow access.

The user scopes are the 30 that Slack's MCP server supports. For read-only use, drop the write scopes: `canvases:write`, `channels:write`, `chat:write`, `files:write`, `groups:write`, `im:write`, `lists:write`, `mpim:write`, `reactions:write`.

## 2. Add the server in mootr

1. Open **Settings › MCP servers** and add a server with the **Remote url** kind, the URL `https://mcp.slack.com/mcp`, and the **OAuth** login.
2. Paste the app's **Client ID** and **Client secret** (from the app's **Basic Information** page) into the two fields. Slack's server has no self-registration, so both are required.
3. Save, then **Log in**. Slack asks you to allow the app, and mootr keeps the token. Every harness then reaches Slack through the daemon.

The same entry, as mootr's config, is `{"mcpServers":{"slack":{"type":"http","url":"https://mcp.slack.com/mcp"}}}`, with the OAuth fields added under `auth`.

## Notes

- Slack issues user tokens that rotate. mootr keeps the refresh token it gets back, so the login survives.
- Events from Slack (new messages, mentions) are not wired yet; this covers the MCP side only.
