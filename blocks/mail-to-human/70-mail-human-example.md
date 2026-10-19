---
id: mail-human-example
title: Mail example
summary: |
  A worked example mail with a TLDR, a decision, a yes-or-no spend question and metrics.
  Copy its shape.
scope: global
kind: recipe
summary_of: 90a1c14addfb71fc90e1b4b42d271b01c6b198a30a2ffe52bebed8a61b2aeead
---
Example:

````markdown
TLDR: The SSO fix works; pick the token lifetime.

```decision
How long should SSO tokens live?
- 1 hour: safest, users re-login daily (recommended)
- 12 hours: one login per workday
```

```yesno
Spend about $14 on the full test run? (recommended: yes)
```

```metrics
Tests: 214/214 [success]
Spent: $0.42
```
````

