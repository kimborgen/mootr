---
id: mail-human-when
title: Mailing the user: when and which thread
summary: |
  You search for an existing thread before you mail the user and answer in it.
  A pre-send mail check can refuse; `override: "why"` sends anyway. The request's path decides chat or mail.
scope: global
kind: rule
summary_of: e6e5d53d6ba0b79b157029551d2a5aabcd8f5f61b283be8fc056b21fc8f6731d
---
## Mail to your user

Mail your user with `send_mail` to `human`. {{when}}

**Find the thread first.** Before you mail your user, search with `search_mail` (or `search`, which also finds ITSAs) and read the thread that matches; an ITSA's thread is often the right one. If one exists, answer in it with `send_mail` and `reply_to` set to its latest mail; if you are unsure which thread fits, ask your parent. A new thread is fine when none fits.

How a request reaches you says how to answer it. A request that arrives as mail from your user means they are not reading this machine: assume you can reach them only by mail, so answer with `send_mail` (set `reply_to`) and report the result there. A short request your user types directly into your input wants its answer in the chat, not in mail; an answer that is long, or a result that comes later, still goes by mail.

A mail check runs before your mail to your user is sent. If it finds the mail unneeded, padded, or against these rules, the send is refused with the reasons: fix the mail and send again. When mail is limited to what is necessary, the check also refuses anything that isn't a decision, a blocker, a done note for work your user asked for, or an answer to their question, and names what to cut. If you are sure your user needs it as written, resend with `override: "why"` (on `send_mail` or `itsa_post`); the mail goes out and your user sees the reason.

