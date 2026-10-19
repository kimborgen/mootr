---
name: system-view-motion
description: Motion rules for the stam system view (web/src/system/, the w:system pane, epic S-445). Use when writing or reviewing animation, transitions, flying mail, spawn or archive motion, mode changes, or number rolls in the system view. Builds on the animate, animation-performance, and review-animations skills, and the colours and tokens of docs/design-system.md still apply.
---

# System view motion

The system view is a live picture of the whole stam system: the agent tree, mail flying between agents, and cost and issues moving as they change. It is exempt from the motion rules in docs/design-system.md, which keep motion to a minimum everywhere else. Its motion carries data, so these rules replace the usual ones here.

Use the three copied skills for technique: `animate` (choosing and building motion), `animation-performance` (frame budget), and `review-animations` (review against the craft bar). They live in `.claude/skills/` with their licence in `LICENSE-emilkowalski`. This skill adds the data-visualization rules.

## Meaning

- Every motion encodes one real event: mail sent or read, spend, a status change, a spawn, an archive. (S-445 proposal: every mark's motion must show a data change.)
- No idle loops, pulses, or spinners; a quiet system is a still page. (design-system.md, "Calm at rest")
- Object constancy: key every card, wire, and sheet by a stable agent or mail id, so the same object animates instead of being replaced. (https://bost.ocks.org/mike/constancy/)
- Coalesce bursts: one flight plus a count bump, not one flight per event. (S-445 proposal: bursts summarise)

## Mode changes

- Mode transitions run in stages: wires fade out, nodes move, then wires grow back. (Heer & Robertson 2007, "Animated Transitions in Statistical Data Graphics")
- Interpolate radial layouts in polar coordinates, along the shortest arc, so nodes never cross the centre. (S-445 proposal: polar interpolation)
- Mode changes take 600-900 ms. (Duration: `--duration-flight`-scale, not micro feedback)

## Geometry and performance

- FLIP for layout changes: measure, invert with `transform`, then play. Animate only `transform` and `opacity`. (https://aerotwist.com/blog/flip-your-animations/)
- Mail sheets follow a quadratic or cubic Bézier, evaluated analytically per frame. Don't use `offset-path`. (S-445 proposal: analytic Bézier)
- One shared `requestAnimationFrame` loop drives all flights. It writes to refs and `style`, never to React state. (animation-performance: React, don't animate through state)
- Set `will-change` only while something moves. (animation-performance: `will-change`)
- Never animate an inherited CSS variable on a container. Set `transform` on the element. (animation-performance: inherited CSS variables)
- Never `transition: all`. List the properties. (review-animations, standard 7)
- A PR that adds or changes motion ships its own real-browser check in its first commit, with `web/check/rowflip.mjs` as the template: pause animations on creation, wait on state, restore in `finally`, and assert computed transform or opacity and painted geometry. jsdom and stubbed-Motion tests don't count as coverage for motion.

## Timing

- Micro feedback runs 100-200 ms. (animate: button press and tooltip durations)
- A mail flight runs 400-880 ms, scaled by distance: `--duration-flight` (880 ms) is the longest hop, and shorter hops scale down to 400 ms. (S-445 proposal: distance encodes time)
- Springs for anything interruptible, with bounce 0.2 or less. (animate: springs for gestures; bounce 0.1-0.3)
- Ease-out on entrances and exits, or the flight curve (`--ease-flight`). Never ease-in on UI. (animate: responsive easing)
- Stagger by depth or angle, 20-40 ms per step, at most about 300 ms in total. (animate: stagger 30-80 ms, tightened for a dense tree)
- Anticipation and follow-through on flights, used sparingly. (Animation principles: anticipation, follow-through)

## Shape

- A spawn grows from its parent: start at scale 0.9-0.97 with opacity 0, from the parent's position. Never `scale(0)`. (animate: never ship `scale(0)`, start scale 0.9-0.97)
- An archive shrinks back toward its parent and fades. (Object constancy: exit the way it entered)
- Stamps: scale 1.15 to 1 with a slight rotation, once per event. (S-445 proposal: stamp marks a receipt)
- Rolling numbers use tabular figures. When updates arrive faster than the roll, skip frames rather than queue them. (S-445 proposal: no lag behind the data)

## Reduced motion

- No travel, no spin. A highlight at the destination replaces the flight. (`prefers-reduced-motion`, review-animations standard 8)
- Mode changes become a crossfade. (Heer & Robertson: the same stages, without movement)
- Keep the colour and the count; drop the movement. (animate: reduced motion means fewer and gentler, not zero)

## Opus 5.5 prompting

- Name the specific patterns to avoid in every prompt to a model working on this view. Pattern list: `transition: all`, `scale(0)`, idle pulses, `offset-path`, state in `requestAnimationFrame`, `ease-in` entrances, layout-property animation.
- After each iteration, add any new pattern a reviewer or a screenshot caught to that list.
- Run a screenshot-and-critique loop at phone 360 px and desktop, in light and dark, before calling a change done. Check that every motion still shows an event.

## Libraries

- `d3-hierarchy@3.1.2` for the tree layout (exact pin).
- `motion@13.4.4` for springs and layout animation (exact pin).

## Tokens and colours

- The tokens and colours of docs/design-system.md still apply: `web/tokens.css`, `web/tokens-stam.css`, the status vocabulary, and the harness hues.
- Motion tokens for this view are in `web/tokens-stam.css`: `--duration-flight`, `--duration-tick`, `--ease-flight`, `--size-card`. Use them rather than new values.
