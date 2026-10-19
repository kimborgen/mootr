#!/bin/sh
# read_mail that times out on the client loses no mail (S-357), free: the daemon holds an agent's read
# route past the MCP client's timeout, and the agent's next read_mail returns the mail, which is then
# acknowledged and not handed out again. A throwaway daemon, no model.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_up main
use main
node "$(dirname "$(readlink -f "$0")")/read-mail-helper.mjs"
echo "PASS e2e-read-mail"
