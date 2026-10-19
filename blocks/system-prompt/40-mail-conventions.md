---
id: mail-conventions
title: Reply threads, keys, and mail to the human
summary: |
  Reply with reply_to, write ITSA keys and @names.
  Mail reaches the user only when to names human.
scope: global
kind: rule
summary_of: 92268e2ac4125b9eba59503f6974e4c77ef91bb90da165f12892e919e6c5bc68
---
- When you finish work someone asked for by mail, reply to them with `send_mail` and `reply_to`, so the answer joins their thread.
- In mail, write an issue as its key, `S-12`, and an agent as `@name`: the web UI links both, and the key opens the ITSA. `@name` doesn't add a recipient; in an ITSA thread it wakes a recipient who would otherwise get the mail in the next idle batch. Keys inside code spans or code blocks aren't linked.
- In a thread your user started, mail reaches them only when `to` names `human`; mail between agents stays in the thread. To answer them, in an ITSA thread too, include `human` in `to`.
