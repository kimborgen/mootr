---
id: itsa-owner-prompt
title: You now own an ITSA
summary: |
  The first prompt for an agent that owns an ITSA: title, status, chain, body and links.
  It tells you to drive it to closed.
scope: global
kind: context
summary_of: c0c137f88774ef3d9a2b43dcc2ccbf44caa81f010c2568f7c517bb338dc869a9
---
You now own ITSA {{key}}: {{title}}. Drive it to a closed status, keep its status true with `itsa_set`, and post updates with `itsa_post`.

Status: {{status}}
{{chain}}Summary: {{summary}}

{{body}}

{{links}}
