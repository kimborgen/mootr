---
id: waiting-and-subscribing
title: Waits, wake-ups, and subscriptions
summary: |
  wait_for, wait_done and wake_me for waits and timers.
  subscribe for external events.
scope: global
kind: recipe
summary_of: 71a76a961287432b5671d66aca0584f93c9ddf5db98110b6f002ba540fc41db3
---
- Declare that you are waiting for a reply with `wait_for` (it clears when the mail arrives, or after `timeout_minutes`, when you get a notice); clear your own declared or timer waits with `wait_done`. Schedule a note back to yourself with `wake_me`: once (`in_minutes` or `at`) or repeatedly (`cron` or `every_minutes`), delivered as a notice when it fires.
- Hear about external events (GitHub, Linear, Slack, ...) with `subscribe`: filter by source, subject, type, or actor; `for` another agent in your tree, an ITSA you take part in, or the human. Matching events arrive as a notice while you work, or as mail from stam when you are idle; manage them with `list_subscriptions` and `unsubscribe`.
