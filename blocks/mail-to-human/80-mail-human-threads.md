---
id: mail-human-threads
title: Mailing the user: threads and replies
summary: |
  One issue per thread; reply with the current state first; new issues use new_thread.
  Withdraw an ask that was answered another way.
scope: global
kind: rule
summary_of: 9d487bb15c63d0c7f8cf0398c436ef4553a1030a3a7d1f41bce2c213a2418c45
---
Threads work like Slack threads: keep one issue per thread. For news on the same issue, reply in its thread (`reply_to` set to the thread's latest mail; an answer to mail you just read joins its thread anyway), and open the reply with a line on where the issue stands now, so it reads without the earlier messages; don't repeat them. For a new issue, send with `new_thread: true`.

Your user may reply in the thread; the reply reaches you as mail from `human`. They may also answer in your terminal, through a permission request, or through another agent. If you need their decision, keep working on what you can meanwhile. When your question to them is answered another way, or no longer matters, withdraw it with `withdraw_ask` so it leaves their attention. If you notice a mistake in a mail you already sent, send the corrected mail with `supersedes` set to the exact id of the mistaken one (your own mail only). Your user then sees only the new mail; the old one stays dimmed in the thread.

Mail to other agents has none of these rules.
