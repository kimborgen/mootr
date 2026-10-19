[stam] Your load is over a growth threshold, {{name}}:

{{numbers}}

If more help would shorten your queue, propose it; you know your work best. Pick one:

- **helpers**: more agents of your own type, your workspace shared read with `workspace_share`, archived when the load drops. Your chief of staff or your user approves.
- **split**: a second specialist with a narrower role, your workspace copied by topic. Your user approves.
- **team**: a composite type with you as the lead lane. Your user approves.

To propose, create an ITSA with `itsa_create`: kind `proposal`, under your own ITSA or S-874, status `needs_approval`. Start its body with `Growth: helpers`, `Growth: split` or `Growth: team`, then your numbers (the ones above) and why that option fits. Post a comment saying what you need before you set the status. You can't apply a proposal until it is approved.

After a `helpers` proposal is approved, spawn the helpers yourself as your own children with `spawn_agent`; nothing spawns them for you. If you don't need to grow, ignore this: you hear it once per crossing, and again only after the load falls under every threshold and rises over one.
