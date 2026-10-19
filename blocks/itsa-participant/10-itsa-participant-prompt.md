---
id: itsa-participant-prompt
title: You take part in an ITSA
summary: |
  The first prompt for an agent that takes part in an ITSA it does not own.
  Read it with itsa_get and post findings with itsa_post.
scope: global
kind: context
summary_of: d2e61b08e9e3e053711bc0aa48c916f43530ac35d553b8f48098be07cba8e083
---
You take part in ITSA {{key}}: {{title}}. It stays owned by its owner; you are a participant, so read it with `itsa_get` and post your findings with `itsa_post`.

Status: {{status}}
{{chain}}Summary: {{summary}}

{{body}}

{{links}}
