# Design system

mootr's web UI follows this design system, "Instrument and manuscript". It is mootr's own document: edit it here, in the same change as the UI it governs.

## In mootr

The base token layer is `web/tokens.css`, and `web/fonts/` holds subset builds of Source Sans 3 and Source Code Pro, self-hosted. `web/style.css` consumes semantic tokens only. Don't add a colour, size, or duration to it that the token layer doesn't define.

**What applies.** Everything about chrome: identity and the first principle, colour, contrast, the chrome type scale and roles, space, density, radius, elevation, shadows, motion and the reveal contract, focus, icons, the state vocabulary, components, empty and error grammar, the persona rules, and the developer rules.

**What doesn't.** mootr has no manuscript, so the writing surface, the document type scale and STIX faces, the scholarly apparatus, the override contract, and print and export don't apply. mootr does view PDFs, read-only, in the file view: the PDF viewport, sheet and shadow rules ("Writing surface and PDF", the PDF error grammar, dimmed rather than inverted in dark theme) apply, and the PDF annotation interface (highlights, notes, the selection popover, find washes) does not, because there is nothing to annotate. Two of their conventions carry over to Markdown in mail, which is prose set at chrome scale: inline code is monospace ink with no pill, block quotations are set by indentation rather than a left bar, and tables rule horizontally only.

**mootr's additions** live in `web/tokens-stam.css`, built only from the base primitives and semantics, with no new hues or neutrals:

- Agent state maps onto the status vocabulary: working takes the accent, as in-progress does; idle takes success; blocked takes warning; errored takes error; paused, resting and stopped are neutral; resting (a long-idle agent whose harness is stopped) is a dashed ring with a dash pip and a badge that says what it waits for and when it wakes, in the viewer's local clock. A state ring never spins or pulses, because motion confirms causality and never performs.
- A warning note (`.set-note.warn`, and `.set-note.scope-stale` for a stale copy of the shared settings) takes `status-warning-bg` and `status-warning-fg` with a `triangle-alert` icon and says in words what is on and what to do: Settings › Permission modes uses it while Bypass is on. An informational note takes the in-progress pair, and neither tone is ever the only channel, since the words carry it.
- One exception to "motion never performs", by the maintainer's ask (S-205): the working indicator in mootr's own view of an agent, where its next output will appear. Three dots in the working colour pass a slow wave (or breathe together while the agent thinks) on `--duration-working`, six times `duration-slow`, so reduced motion stills them with the other tokens. State rings and glyphs stay still.
- A second exception, by the maintainer's ask (S-1451): the loading mark (`web/src/Loading.tsx`) replaces the progress badge where a view's first load is still running. It is the mootr logo at work: an accent arc turns round the ring and the bot bobs and blinks, on `--duration-loader`, by transform and opacity only. It fades in after `--duration-hold`, so a fast load shows nothing. Reduced motion stills the movement and keeps only the arc's slow breathe. Loaded and empty still shows the empty-state text.
- mootr has its own palette on top of the base one: one muted hue per harness, used only for the harness mark in the tree, tabs, and settings. The state ring around the mark keeps state, so a colour never means two things. Each hue is a non-text indicator and was computed against every surface it sits on:

  | Token | Harness | Light | Dark | Worst contrast, light / dark |
  |---|---|---|---|---|
  | `clay` | Claude Code | `#A8553A` | `#D98B6E` | 4.27:1 / 5.08:1 |
  | `teal` | Codex | `#2F7A69` | `#6BB8A5` | 4.19:1 / 5.83:1 |
  | `plum` | OpenCode | `#8B4E92` | `#C391C8` | 4.77:1 / 5.30:1 |

  The worst case is on `surface-app` or the selected-row fill. Plum sits 1.14:1 from the indigo accent and clay 1.28:1 from the error rust in luminance, so they're told apart by hue, and both are only ever marks, never fills or ink.
- Charts in mail have their own series palette, `--series-1` to `--series-6`, in that order: indigo, ochre, teal, rose, plum, clay. A series colour means only what the chart's legend says; a series named for a harness takes that harness's hue instead, so the harness hues keep their meaning. Rose is the palette's one new hue (`#A3486F` light, `rose-500` dark); the rest are base primitives or the harness hues. Every series colour is at least 4.4:1 against the page, raised, and pane surfaces in both themes.
- Code in mail is coloured by kind on mootr's syntax tokens: keywords take the accent, strings teal, numbers plum, attributes rose, comments the muted text. Status hues stay out, since they never decorate. Each is at least 4.5:1 on `code-bg` in both themes; light strings use `#286D5E`, a darker teal, to reach it.
- ITSA statuses map onto the same vocabulary through `--is-*`, one per category: backlog muted, ready secondary, active and review in progress, the closed category's first status (done) success and the others muted; blocked and every status that waits on the human take warning, as a blocked agent and a waiting approval do. The glyph's shape says the category too, so tone is never the only channel.
- Requirement conformity maps onto the same vocabulary through `--rq-*`: likely conforms success, likely violates error, unsure warning, unverified muted. The glyph's shape says the state too, and the words always say "likely": a check is an indication, never the truth.
- The PR diff view's file column is `--size-diff-side` (17rem, S-1918), a layout size, not a type or spacing step. The pane's width decides when it shows (720 px), as for every pane.
- Model names are neutral badges.
- Terminals stay dark in both themes: a harness's screen is a fixed artifact, like a PDF sheet that is dimmed rather than inverted.
- A mail message lies on its thread's deck like a sheet: `surface-page`, square, a hairline and no shadow.
- Mail thread (S-1471): on desktop the thread's head, messages and reply sit in one column at `--measure-conversation`, centred on the deck, the same measure and centre line as an agent's conversation. The head scrolls away with the messages, and the bottom input centres at the same measure under a thread tab. The bottom input takes the focused pane's column: its edges are the messages' column's edges (`.ov-col`, `.thread-head`), so it lines up at every pane width and with a scrollbar; with one pane it is full width, as before (S-2284).
- A permission card that waits on you takes a comment (S-3829): one `.perm-comment` input, a `--size-control` field on its own row, placeholder "Add a comment…" in text-muted, above Approve and Deny, which sit in the same `.perm` row. On a phone the field takes the card's width on its own row, and Approve and Deny keep their own size below it, at `--size-hit-touch` or larger. The comment travels with the answer it is sent with, read when the reply is sent, so a comment typed after Approve was tapped still goes; it is never shown as a separate reply. On a harness dialog a one-line `.perm-hint` under the field says the agent reads the comment after Yes is typed, since a dialog's Yes is a key, not a reply.
- Mail components (`docs/mail-components.md`) are apparatus, not cards: a callout is a hairline note with a coloured label and no tinted fill, an agent mention is link ink with the harness mark and never a chip, a decision's options are bordered rows, and a diff tints only its changed lines.
- The persona rules ban toasts. What has a place on screen reports there: settings save state in the settings nav, a permission answer on its mail, a send in its prompt input. What has none, such as the result of a menu action, takes the one exception the rule allows: a single transient bar at the top centre, which a newer notice replaces rather than stacks under. The bar has one persistent case, a state the person must act on rather than a notification: the local login offer (S-2121, `.login-offer`), shown when a page on 127.0.0.1 that isn't logged in as the human is refused a human action. It is the same bar, never a second one: the bar's standing notice, with Log in and Dismiss. A transient notice covers it while it shows, then it returns; dismissed, it comes back with the next refusal, and Settings keeps a Log in meanwhile.
- The executive assistant's drop-down is the top overlay world: `overlay-panel-bg`, `radius-lg` at its bottom corners, `shadow-raised`, over the scrim.
- The desktop nav bar is the sidebar's footer: its icon buttons are `.icon-btn`, in one row (theme, the Inbox, Work and Agents pages, Settings, Usage, System view, Process view). The page the icon opens is pressed: `.icon-btn.on`, accent-subtle, with `aria-current="page"`. Inbox carries the count that waits on you as the warning `.badge` at the icon's corner. The page icons are hidden on a phone, where the bottom bar opens the pages (S-1428).
- The sidebar panes are separated by a draggable gutter (S-3810): `.sep.h`, 5 px high with a 1 px `--separator-idle` hairline, `--separator-hover` on hover and `--separator-drag` while dragging (`--duration-fast`), `touch-action: none`. It is `role="separator"`, focusable, with the focus ring on keyboard focus. Neither pane shrinks below `--size-side-pane-min`. The drag moves the two panes live and writes the ratios to the settings record once, on release; a double-click resets to 3/2/1. The phone draws no panes, so no gutter.
- The system view (`w:system`, epic S-445) is exempt from the motion rules, by the maintainer's decision of 2026-10-13: it may animate events freely, under `.claude/skills/system-view-motion`. Everything else (colour, tokens, type, radius, no toasts) still applies.

## Identity

**Instrument and manuscript.** The workspace is built from one warm-neutral family — the color of good paper and pencil graphite — so tool chrome and document surface read as parts of a single physical desk rather than a webpage wrapping a document.

*A quiet reading room with precise instruments: calm, print-like, slightly warm, never glossy.*

### First principle: Calm at rest; instruments on approach

At rest, every surface shows state and nothing else. On the writing surface this has a stricter, older name that stays in force — at rest, the page is print: nothing appears there that would not appear on a printed page. In chrome, controls materialize on hover or focus and vanish when attention leaves. And calm is rhythmic rather than merely empty: vertical space is a system that encodes relatedness, so things that belong together sit closer than things that do not, by rule rather than by eye.

This is one principle with two jurisdictions, and it is where the Notion study landed. Stating the page rule and the chrome rule separately invites chrome to drift glossy while the page stays honest. It costs zero tokens.

### Rationale

- Hierarchy is carried by lightness, not hue. The document page is always the lightest, most open surface in light theme and the most lifted in dark; chrome recedes one or two steps behind it.
- A single restrained indigo is the only hue with interactive meaning. Everything else that is colored is either a status or an annotation on a source.
- Researchers spend hours reading long-form text here, and the deepest precedent for long-form reading surfaces is book stock: publishers set text on cream and natural paper and reserve bright white for plates. The warm cast is that precedent held at whisper level — an association and a fidelity choice, not a glare claim. Glare is a function of luminance rather than hue, which is why every level of this system is specified as a lightness step.
- Chrome is dense; the manuscript is generous. These are two different instruments and they do not share a scale.

### Warmth ceiling

The risk in a warm palette is drifting into the beige branding common to 2020s software, so warmth is bounded by a computed rule rather than by taste: no surface a user reads against may exceed an RGB channel spread of 12. Measured, the four primary surfaces sit at 4, 6, 9, and 11. surface-sunken is the single deliberate exception at 15 — it is a recessed deck seen behind PDF pages and is never read against. Borders and text are uncapped and run to 17 at sand-300, which is correct: they are hairlines and glyphs, not fields. An earlier pass proposed this ceiling as a global one and was wrong on the arithmetic; the measurements are recorded here so it is not proposed again. What separates this workspace from cream-colored consumer software is everything else in this document — square pages, hairline rules, dense chrome, no gradients, one accent.

## The Notion study

### Question

The brief was literally "Notion has amazingly beautiful design, I don’t know why." Finding out was the assignment, so this was researched from Notion’s own design engineering writing and its founders’ stated philosophy rather than from what is commonly repeated about it.

### Finding

It is a philosophy executed, not a style. Notion was built under the explicit influence of Douglas Engelbart’s Augmenting Human Intellect and Alan Kay’s tools-for-thought program — computers as instruments that make people more capable rather than products that entertain them. Notion looks designed because every surface answers to one idea that predates every widget. The lesson is not any Notion pixel; it is that a stated identity, enforced everywhere, is what "beautiful" actually consists of. That is the same structural position this system’s identity occupies, which is why the study strengthens it rather than redirecting it.

### Mechanics

- The page at rest is nearly empty of interface. Structure is carried by type size, weight, and whitespace — not by fills, borders, or hue.
- Controls materialize on approach and vanish at rest. Drag handles, insert buttons, block menus, hover toolbars: none exists until the pointer or focus arrives. Progressive disclosure applied as a visual discipline, not merely an information-architecture one.
- Spacing is a system, not a property. Notion’s 2024 page-design work replaced per-block spacing with an adjacency model, where a block’s spacing depends on what its neighbors are, so consecutive list items chunk together while paragraphs keep paragraph-scale air. They also draw a hard line between line spacing inside a paragraph and paragraph spacing between blocks, which most editors blur.
- Per-page style is a tiny contract rather than a panel: font, small text, full width. Three controls restyle a whole page coherently. Notion proved at enormous scale that per-document typography needs a handful of values, not a style inspector.

### Hypothesis tested

The proposed reading — that Notion’s achievement is restraint and progressive disclosure — is confirmed but incomplete. It names the first two mechanics and misses the third: Notion’s calm is rhythmic, and the adjacency spacing system is why a page full of mixed content looks composed rather than merely sparse. Restraint without spacing systematics produces emptiness, not calm. That third leg is why the first principle above carries a rhythm clause.

### Transfers

- The reveal contract: tab close buttons, row actions, the block handle, and the annotation toolbar exist only on hover or focus-within. They fade in at duration-fast and vanish at 0ms — the same asymmetry as menu exits. At rest a tab shows state glyphs, never controls.
- Block-level actions in mail components show at rest (the diff block's Open, a decision's options): touch has no hover, and the block is the reader's to act on. Row actions keep the reveal contract. On touch, `--size-hit-touch` overrides the compact chrome row height, and a block action is at least that wide.
- A bar that holds a touch target and has a 1px border is sized `calc(var(--size-hit-touch) + 1px)`, as `.tabbar` is: under border-box the border comes out of the content, leaving 43px for a 44px button.
- The binding rule: consecutive list items space at 0.25em against doc-para-space at 0.75em; headings bind forward; captions bind to their objects. Stated as one adjacency rule so future block types inherit it rather than each inventing its own spacing.
- The override contract stays capped at eight tokens. Notion restyles a page with effectively three controls, so eight is already generous. The cap is now a rule rather than a count that happens to be current.
- Line spacing and paragraph spacing are different things, already structural here as doc-leading-body, doc-para-space, and doc-para-indent. Confirmed, kept, and now citable to precedent.

### Still banned scope

The list splits in two once a writer can declare style properties directly. What the product itself emits is unchanged and every entry below still binds it: none of these appears because WCS chose it. What a writer may build with the controls in front of them is not restricted by this list at all — a writer who wants a tinted callout may declare one, and the product neither offers it as a preset nor prevents it. The ban is on the system having a period style, not on the writer having a bad day.

### Still banned

- Mention chips. Citations are colored ink; no paper has ever boxed its citations.
- The icon-in-a-tinted-rounded-square empty state. Empty states here are purely typographic.
- Callout blocks — emoji plus tinted rounded fill. A manuscript’s callout is a note, and notes are apparatus.
- Emoji page icons and cover images. A manuscript is a public record, not a personal space; WCS never offers page decoration.
- Skeleton shimmer, already banned outright.
- The always-visible handle pair. Handles are hover-only margin instruments; a persistent handle column is a block editor announcing itself.
- The gray inline-code pill. On this page, inline code is monospace ink with no fill.
- Toggle switches, toasts, and boxed keycaps — adjacent SaaS grammar.

### Conflicts

- The block is Notion’s unit of thought; a manuscript’s units are the paragraph, section, and argument. Notion’s own redesign was a confession that per-block styling fragments prose — they spent an engineering cycle making blocks look continuous. This system starts from continuity: block machinery is invisible mechanics in the margin, and typeset conventions Notion cannot represent at all — first-line indent mode, numbered sections, hanging-indent bibliographies, booktabs tables — are first-class.
- Notion pages are personal spaces that invite decoration; a manuscript must refuse it. No icons, no covers, no per-block color, no text-color menu. The one ink a writer can apply is citation ink, and it applies itself.
- Notion unifies everything in one family and one scale; this product constitutionally cannot. Notion’s serif toggle is a costume over an app page. Here the serif manuscript is the product and the sans chrome is its instrument panel — two scales, two jurisdictions, one desk. Copying the unification would flatten the product’s central distinction.
- Notion has no output target; this product is governed by export. Notion pages have no measure, no pagination, and no "done". Here the measure is bounded, apparatus follows journal convention because the destination is a journal, and every document decision must survive the trip through LaTeX.
- Notion embeds databases in content; this product’s reference table is chrome. A Notion database is page content with chrome-ish controls inside it — the exact boundary blur this system forbids. The reference manager is an instrument; the bibliography on the page is typeset apparatus. Same data, two jurisdictions, never mixed.

## Confidence

### Settled

- The full token vocabulary and every color value, computed against WCAG AA with stated exemptions.
- Both type scales, with metrics measured from the font binaries and a subsetting policy that makes OpenType feature survival a CI property rather than a hope.
- The complete scholarly apparatus, including lists, inline and block code, figures, links, and block selection.
- The eight-token override contract and its export round-trip semantics.
- The complete state vocabulary satisfying REQ-SHELL-VIS-STATE, with the channel-composition rule.
- Buttons, inputs, tooltips, checkboxes, badges, modals, menus, trees, tables, scrollbars.
- Empty, loading, and error grammar per surface; multi-view differentiation; the PDF annotation interface; narrow-pane behavior; the print and export token layer; the microcopy register.

### Note

There is no provisional list. Every question this system raised is closed in the decision log below, each with the observable that would justify reopening it.

## Decision log

### Colour sits in the advanced tier rather than being refused

**Decision:** Text colour and fills are declarable properties in the advanced tier, carrying the theme advisory, rather than being absent from the vocabulary.

**Reasoning:** Refusing colour outright was the old position and it was a capability claim dressed as a taste rule. The reason behind it is real — a per-document palette breaks theme integrity, and a manuscript that hard-codes ink is unreadable in the other theme — but that reason is a consequence to state, not a control to remove. A writer marking up a draft for a co-author has a legitimate need the product otherwise sends them outside the product to meet. The tier is what carries the discipline: colour is two disclosures deep and advisory-marked, so nobody reaches it by accident.

**Reopen when:** A dogfooded document is opened in the opposite theme and is measurably unreadable — a declared ink against the theme surface computing below 4.5:1 — and the writer did not intend it. That is an argument for resolving declared colour against the theme rather than for removing the control, and the reopen is which of the two the evidence supports.

### An imported document composes rather than imposes

**Decision:** A .sci file imported into another resolves any style it does not carry against the importing document’s context, and packaging styles alongside a travelling document is off by default with a mandatory warning.

**Reasoning:** The alternative is a document that keeps its appearance wherever it goes, which sounds like fidelity and reads as a manuscript full of blocks that do not match each other. Composition is the behaviour a chapter assembled from five imports actually needs. The warning is what stops the default from being a silent loss: REQ-WCS-STYLE-SAVED requires every act that separates a document from a style it refers to to name the styles left behind and offer packaging them instead.

**Reopen when:** A writer reports a document that changed appearance on import in a way the warning did not predict, or the warning fires so often on ordinary work that it is being dismissed unread. The second is the likelier failure and the harder one to see, so the observable is the dismissal rate rather than a complaint.

### The intended output is the WYSIWYG switch

**Decision:** A document declares its intended output once, and that declaration — not a mode toggle — decides whether the writing surface renders a reading measure or a page.

**Reasoning:** REQ-WCS-EDIT-WYSIWYG forbids a user-toggled preview mode and requires the editor to match rendered output. Those two only compose if something states which rendered output is meant, and the document is the only thing that knows. Declaring it once turns a mode into a property: both readings are the same surface, neither is a preview, and the export target the interface checks a property against follows from the same declaration instead of being chosen again.

**Reopen when:** Writers are found changing the intent to see the other reading and changing it back, which would mean the product has grown a mode toggle wearing a property’s clothes. The fix then is a view-local override with the document’s declaration untouched, not a second mode.

### Saved styles are workspace artifacts

**Decision:** A saved style is an ordinary workspace artifact referred to by identity, not a document-embedded block or a global preference.

**Reasoning:** It is the only one of the three that makes REQ-SYS-TRACE-ARTIFACT hold for style, and it gets three properties for free: the reference survives renaming and moving, editing the style changes every use with no propagation step because no scope stores a resolved value, and sharing a style is copying or referring to a file rather than a mechanism of its own. The cost is that a document can refer to a style the workspace does not hold, which is the case the packaging warning exists for.

**Reopen when:** Styles accumulate in a workspace at a rate that makes the artifact tree unusable, which would be an argument for a folder convention or a style-kind filter in FWS, not for moving them back inside documents.

### Document face: STIX Two Text

**Decision:** STIX Two Text is the document face. Source Serif 4 is un-wired and removed from the bundle.

**Reasoning:** The argument was four-legged and only one leg was ever in doubt. Lineage (the face scientific publishers commissioned), the designed math companion (Source Serif has none, which is decisive for a LaTeX-exporting product), the italic that sits beside KaTeX’s Computer Modern italics, and the Times New Roman metric fallback are all settled. The remaining doubt was screen texture, and a doubt about texture does not justify shipping a second 300KB serif family indefinitely.

**Reopen when:** Dogfooding a real paper on a non-retina display produces a documented rendering defect attributable to STIX — spindly hairlines, broken hinting — that a screenshot demonstrates. The trigger is a demonstrable artifact, not a taste report. Nothing else depends on the family choice, because everything document-side is em-derived.

### Document body size: 17px

**Decision:** doc-size-body is 17px, measured rather than reasoned.

**Reasoning:** Measured from the binary, STIX Two Text has an x-height of 0.473em. At 17px the body’s x-height is 8.04px; at 16px it is 7.57px. The chrome face measures 0.486em, so ordinary 16px chrome text carries a 7.78px x-height — meaning a 16px manuscript would read smaller than 16px chrome, inverting the system’s own hierarchy. 17px is the smallest size at which the manuscript clearly exceeds any chrome text. At 17px the measured digit advance of 0.495em gives 75ch = 631px, so a full measure plus its minimum side padding wants 679px — a half-split of a 1440px window before shell chrome is deducted from it.

**Reopen when:** The measure moved first, and in the opposite direction to the one anticipated here: writing on a wide pane reported the column as too narrow, and it went from 65ch to 75ch. That spends the widening move — 75ch is the top of the 45–75 range that governs continuous reading, so at 17px the pair is now at its ceiling and any further width has to come from a larger body size, which reopens the size. The trigger in the other direction still stands: the narrow-pane collapse state comes to dominate real usage on 13-inch hardware, which is evidence the pair is too large for the actual desk. Either way the pair gets revisited together, never one of the two alone.

### Chrome xs step: 11px

**Decision:** 11px stands. The fallback, if ever needed, is 12px — not 11.5px.

**Reasoning:** The xs step is used exclusively for scanned labels — badges, eyebrows, section labels — at weight 500 with tracking or small caps, never for running text. The critical-print-size threshold cited elsewhere in this document governs continuous reading speed, which xs never carries; a five-character tracked label is pattern recognition, not reading. Measured, the chrome face at 11px weight 500 gives a 5.35px x-height, comfortably above glyph-recognition limits on any display this product targets. The half-pixel escape hatch is deleted on principle, because half-pixel sizes alias on 1× displays.

**Reopen when:** A user on a 1× display reports the small-caps section labels illegible rather than merely small. Then xs moves to 12px and badge paddings absorb the change.

### Reference table rows: 28px

**Decision:** size-row-table is 28px. The 26px alternative is rejected as a default.

**Reasoning:** Reference cells are editable in place, and an input needs a visible interior: 28px hosts the 16px cell line with 6px above and below, enough for descenders and the 4px inset focus ring without collision. 26px saves 7% vertical density — a 700px viewport shows 26 rows instead of 25, one additional row — in exchange for every edit feeling cramped. The WCAG target floor leaves 28px with margin once the ring is live; 26px leaves almost none.

**Reopen when:** Real libraries routinely exceed roughly 300 entries and users demonstrably scroll where they should filter. The remedy is then a compact 26px mode offered as a view option. The default never changes, because a default should fit editing, which is the primary act.

### Page margins and the collapse breakpoint

**Decision:** The writing page takes 64px top, 96px bottom, and clamp(24px, 8%, 56px) per side. The sheet collapses at 679px pane inner width: below it the page runs flush with the pane, keeps surface-page, drops shadow-page, fixes side padding at 24px, and the measure yields to available width.

**Reasoning:** 679 is derived, not a round number. The full measure is 75ch = 631px at 17px STIX, using the measured digit advance. Add the minimum viable side padding of 24px on each side and the narrowest pane that can hold a full-measure sheet is 679px. So that is precisely the width below which sheet chrome would start costing manuscript measure — and when the sheet competes with the manuscript, the sheet loses. It is the pane’s width that is asked, not the window’s: WCS shares the shell with other panes, so a narrow manuscript inside a wide window is the ordinary case rather than the edge one, and a viewport query would keep charging that pane for page chrome it has no room for. A block’s own chrome has a second, higher threshold derived the same way and it is deliberately not the same number: a drag handle hanging in the margin needs one control plus its gap, 36px, out of the (pane − 631) / 2 available each side, so it survives to 703px and is overlaid on the block below that. The two ask different questions — whether the writing still fits, and whether the chrome beside it does — and collapsing them into one number would answer the second question with the first one’s evidence.

**Reopen when:** The size-and-measure pair is revisited. The breakpoint is a pure function of that pair — measure plus 48px — and must be re-derived with it rather than re-guessed.

### Focused-block marker: the margin bar, during block operations only

**Decision:** A 2px accent bar in the left margin, 12px left of the text column, spanning the block’s line boxes. It appears only when a block is the object of a block-level operation: block selection, keyboard block navigation, drag, or an open block menu. During ordinary typing nothing marks the block — the caret is the marker.

**Reasoning:** Three forces align. The outline pane already marks the current section with the identical bar, so "where you are" and "what this operation targets" share one vocabulary. At-rest-is-print holds because the bar lives in the margin, so the printed area of the page never changes. And the original worry — that outlining every paragraph the caret enters would make writing feel inspected — is dissolved rather than balanced, because the marker does not exist during writing. Computed as a non-text indicator: 4.94:1 on the light page, 4.58:1 on the light pane, 5.75:1 on the dark page, 6.03:1 on the dark pane.

**Reopen when:** Keyboard users demonstrably mis-target block operations, indicating the bar appears too late or reads too faintly. The remedy is timing — mark on operation arm rather than execution — before it is ever geometry.

### OpenType features: a build invariant, and half the problem measured itself away

**Decision:** Tabular figures need no feature at all. Fonts ship through an in-repo subsetting step with a declared feature keep-list, and eight mechanical probes in tests/typography.spec.ts assert the result against the rendered page.

**Reasoning:** Measured from the binaries at the weights the product actually ships, all ten digits have identical advance widths in both text faces — 495/1000 in STIX Two Text at 400 and 497/1000 in the chrome face at 400 — both exposing proportional figures as the alternate. Tabular lining figures are the default, so every tabular-nums declaration is belt-and-suspenders over a default. The one exception is bounded and measured: STIX narrows the digit 7 by 1/1000 em at 500 and 600 and 2/1000 em at 700, which is two hundredths of a pixel at 17px and touches nothing that sets a column of numbers, since document tables set their body at 400. Separately, derived font builds cannot be trusted to preserve layout features at all, so subsetting with an explicit keep-list converts the risk into a build property. Weights matter to this measurement: a variable font’s default instance is not necessarily a shipping weight — Source Sans 3 defaults to 200 — so measuring the binary as-loaded answers a question nobody asked.

**Reopen when:** Never, as a design question. If upstream lacks a feature, the already-specified fallback rendering is simply the permanent one. The survival check is CI’s job now — which is what closing an item looks like: converted from an unknown into a test. One probe is deliberately inverted: it asserts that the document face has no superior figures, so if a future font bump ever brings the real feature the test fails and the synthesized fallback can go.

### Font provenance: the package is part of the typeface decision

**Decision:** The chrome sans and mono come from Adobe’s own npm packages (source-sans, source-code-pro). The document serif comes from @fontsource-variable/stix-two-text, supplemented by @fontsource/stix-two-math for prose symbols. All OFL, all self-hosted, never a CDN.

**Reasoning:** Two typefaces of the same name are not the same font. Measured: the Google-pipeline build of Source Sans 3 carries no smcp, c2sc, sups, case, or zero — so genuine small caps, a stated design property of this system and one of the six reasons the face was chosen, simply do not exist in it. Adobe’s own release carries all of them. A keep-list preserves what a binary has; it cannot restore what the binary never shipped, so provenance is what guarantees a feature and the keep-list is only what stops the build from losing it. The published STIX Two Text has the reverse problem: it covers Google’s Latin and Greek ranges and omits ≤, ≈, →, ∗, ‡, Å, ∞, and ⟨⟩ — so a paper writing "p ≤ 0.05" would drop into Times mid-sentence. Those come from STIX Two Math, the text face’s designed companion, subset to exactly the codepoints the text face lacks and declared under the same family name; measured, the two share identical typo metrics, x-height, and cap height, and the supplement carries explicit metric overrides so a display delimiter cannot change line height. This is the math-companion argument for choosing STIX paying a second dividend it was not chosen for.

**Reopen when:** An upstream STIX release ships the full text face with its symbol coverage intact, at which point the supplement collapses into the main face and one @font-face rule disappears. Watch the stipub release notes rather than the npm mirrors, which lag it.

### Find matches over scanned PDFs: guaranteed by blend math

**Decision:** Over PDF content, all highlight and find washes render with mix-blend-mode: multiply, and the current-match ring becomes two-tone — 2px #26231F inside 1px #FCFBF8. On the writing surface, which is a known ground, the single-tone rings stand unchanged.

**Reasoning:** The problem existed because scanned paper is not the token sheet color, so per-scan ratios could not be pre-verified. Multiply converts it from empirical to mathematical: a multiplied wash can only darken the ground, and scan ink is always darker than scan paper, so the wash reduces contrast by a bounded, computable factor. Computed with the light wash over representative papers, black ink stays at 14.16:1 on clean paper, 10.92:1 on aged, 8.54:1 on a dark scan, and 6.61:1 on a very dark scan; even mid-gray ink on a very dark scan holds 3.70:1. Any scan legible enough to read is legible enough to search. For the ring, no single color can pass 3:1 against arbitrary paper — the old single ring computes to 2.73:1 against a dark scan, a genuine failure. The two-tone pair’s guaranteed worst case is the square root of the pair’s mutual ratio, √15.11 = 3.89:1, because for any uniform ground at least one of the two tones exceeds it. This is the cartographer’s registration-mark solution, and it is provable rather than checkable.

**Reopen when:** A scan whose native ink-to-paper contrast is already below roughly 6:1 arrives in practice, where the wash could push it under AA. The remedy is per-page wash attenuation — an implementation valve, with the design unchanged.

### Export round-tripping of the override contract

**Decision:** The eight tokens split into six manuscript-semantic tokens that round-trip and two screen-ergonomic tokens that deliberately do not. The three font tokens, measure, paragraph space, and paragraph indent map to export and back. Body size and leading never export.

**Reasoning:** Screen reading size is an ergonomic of this glass, not a property of the manuscript; print size belongs to the journal template, and exporting 17px into a 10pt document class would be a category error. The font tokens accept only shipped families, so the family-to-package table is total. Paragraph space and indent map onto the LaTeX primitives directly, and the space-and-indent collapse rule is the LaTeX default, which is exactly why it was specified that way. The six live in the document’s front matter, which markdown preserves verbatim and LaTeX export writes as a tagged preamble block that import parses back.

**Reopen when:** Never, as design. An export-and-import cycle that loses paragraph-indent mode is an implementation bug against this spec, and the Playwright export spec must assert the cycle.

## Color primitives

### sand — warm light neutrals

Light-theme surfaces, and light text in dark theme. Hue ≈ 40–50°, very low chroma.

| Token | Value | Use |
|---|---|---|
| `sand-0` | #FCFBF8 | Writing page, PDF sheet (light), input fill. Channel spread 4 |
| `sand-50` | #FBF9F5 | Raised surfaces: menus, modal, overlay panel, tooltips. Spread 6 |
| `sand-100` | #F5F2EC | Pane body. Spread 9 |
| `sand-150` | #ECE8E1 | App background, tab bar, table header, code block, dimmed PDF sheet in dark theme. Spread 11 |
| `sand-200` | #E2DDD3 | Sunken wells, subtle borders, separators, neutral badge fill. Spread 15 — the sole surface exception |
| `sand-300` | #D0CABF | Default borders. Spread 17; uncapped because borders are hairlines, not fields |
| `sand-400` | #B5AFA6 | Strong borders; secondary text in dark theme |
| `sand-500` | #918B81 | Muted text in dark theme; freestanding input borders in both themes |

### coal — warm dark neutrals

Light-theme text, and dark-theme surfaces.

| Token | Value | Use |
|---|---|---|
| `coal-0` | #E8E4DC | Primary text in dark theme |
| `coal-100` | #C6C0B7 | Code text in dark theme |
| `coal-200` | #6A655D | Muted text, eyebrows, annotation swatch borders (light) |
| `coal-300` | #57524B | Secondary text (light); strong border (dark) |
| `coal-400` | #3B3833 | Code text (light); default border (dark) |
| `coal-500` | #2E2B27 | Subtle border, neutral badge fill (dark) |
| `coal-550` | #2A2724 | Raised surface (dark) |
| `coal-600` | #26231F | Primary text (light); the dark tone of the two-tone ring over PDFs |
| `coal-650` | #24221F | Writing page (dark) |
| `coal-700` | #201E1B | Pane body (dark) |
| `coal-750` | #1B1917 | Tab bar, table header, input (dark) |
| `coal-800` | #161513 | App background (dark) |
| `coal-850` | #111009 | Sunken wells, code block (dark) |

### indigo — the one interactive hue

Blue is the strongest cultural signal for links and citations in scholarly documents — unbroken from early browsers through every publisher’s PDF — and once green, amber, and red are reserved for status it is the one hue carrying no status meaning. Desaturated and slightly dusty so it sits against warm neutrals without turning corporate.

| Token | Value | Use |
|---|---|---|
| `indigo-100` | #E3E9F5 | Accent-subtle fill (light) |
| `indigo-200` | #C4D1EC | Accent-subtle border (light) |
| `indigo-300` | #9AB2E4 | Accent text and citation ink (dark) |
| `indigo-400` | #7E9CD6 | Accent (dark) |
| `indigo-500` | #4A6DB0 | Accent (light) |
| `indigo-600` | #3A5A99 | Accent text and citation ink (light); ring on light sheets (dark) |
| `indigo-700` | #2F4A80 | Accent-subtle border (dark) |
| `indigo-800` | #232E45 | Accent-subtle fill (dark) |
| `indigo-900` | #131A29 | Text on accent fills (dark) |

### Status and annotation hues

Status hues never appear as decoration. The annotation hues are for PDF highlights and find matches only; transient find matching is the one sanctioned exception to keeping them out of chrome.

| Token | Value | Use |
|---|---|---|
| `moss-100 / -300 / -600 / -800` | #E1EEDF · #93C08F · #3E7040 · #243522 | Success |
| `amber-100 / -300 / -700 / -800` | #F6ECD4 · #D9A84E · #8A5A10 · #3A2E17 | Warning |
| `rust-100 / -300 / -600 / -800` | #F6DEDB · #E28E82 · #A63430 · #3D211E | Error and danger |
| `marigold-500 / -600` | #F2C230 · #EDBA24 | PDF highlight and find match, marker yellow. The -600 step is the hover deepening |
| `sky-500 / -600` | #5CA6E8 · #4E9CE4 | PDF highlight, marker blue |
| `rose-500 / -600` | #EE7FA9 · #EA6F9E | PDF highlight, marker rose |

## Color semantics

### Surfaces and elevation

| Token | Light | Dark | Use |
|---|---|---|---|
| `surface-app` | #ECE8E1 | #161513 | Root background behind everything |
| `surface-pane` | #F5F2EC | #201E1B | Pane container body |
| `surface-raised` | #FBF9F5 | #2A2724 | Menus, modal, overlay panel, tooltips, reveal button |
| `surface-sunken` | #E2DDD3 | #111009 | PDF viewport, recessed wells |
| `surface-page` | #FCFBF8 | #24221F | The writing page. Goes dark in dark theme — it is the user’s own text |
| `surface-scrim` | rgba(38,35,31,0.45) | rgba(0,0,0,0.55) | Modal backdrop. Opacity only — never blur or backdrop-filter |
| `shadow-float` | 0 1px 2px rgba(38,35,31,0.06) | 0 1px 2px rgba(0,0,0,0.40) | Near-floaters: menus, popovers, tooltips, drag ghost. Named for what uses it — panes at rest carry no shadow at all |
| `shadow-raised` | 0 4px 16px rgba(38,35,31,0.14), 0 1px 3px rgba(38,35,31,0.08) | 0 4px 16px rgba(0,0,0,0.50), 0 1px 3px rgba(0,0,0,0.40) | Fully detached: modal panel, top overlay |
| `shadow-page` | 0 1px 3px rgba(38,35,31,0.10), 0 4px 12px rgba(38,35,31,0.06) | 0 2px 8px rgba(0,0,0,0.50) | Writing page and PDF sheet — the only always-on shadow. Dropped when the sheet collapses below 600px |

### Borders and text

| Token | Light | Dark | Use |
|---|---|---|---|
| `border-subtle` | #E2DDD3 | #2E2B27 | Hairlines inside a surface: table grid, menu separators |
| `border-default` | #D0CABF | #3B3833 | Pane borders, tab-bar bottom, menu and secondary-button borders |
| `border-strong` | #B5AFA6 | #57524B | Emphasized edges, hovered separators |
| `text-primary` | #26231F | #E8E4DC | Body prose, headings, active labels. Never pure black or white on screen |
| `text-secondary` | #57524B | #B5AFA6 | Supporting labels, inactive-but-relevant text |
| `text-muted` | #6A655D | #918B81 | De-emphasized metadata, placeholders, shortcut hints, the dirty dot’s inherited ink |
| `text-eyebrow` | #6A655D | #918B81 | Small-caps section labels. Shares muted today; separate so it can diverge |
| `text-disabled` | #B5AFA6 | #57524B | Disabled controls. Intentionally sub-AA; WCAG-exempt |
| `text-on-accent` | #FCFBF8 | #131A29 | Text and icons on solid accent fills |

### Accent, focus, and selection

| Token | Light | Dark | Use |
|---|---|---|---|
| `accent` | #4A6DB0 | #7E9CD6 | Primary button fill, active indicators, focused input border, checked checkbox, the focused-block margin bar |
| `accent-strong` | #3A5A99 | #9AB2E4 | Hover and pressed step |
| `accent-text` | #3A5A99 | #9AB2E4 | Accent-colored text and text buttons, AA-verified |
| `accent-subtle` | #E3E9F5 | #232E45 | Selection fill: rows, tree nodes, progress badges |
| `accent-subtle-border` | #C4D1EC | #2F4A80 | Border on tinted accent fills |
| `focus-ring` | #4A6DB0 | #7E9CD6 | Focus ring color, used with the halo technique. Exactly one ring alive per app |
| `focus-ring-on-page` | #4A6DB0 | #3A5A99 | Ring for elements over the light PDF sheet in dark theme. 5.54:1 on the sheet |
| `selection-bg` | rgba(74,109,176,0.22) | rgba(126,156,214,0.30) | Text selection, and block selection across full line boxes — block selection is selection |

### Tabs and pane header

The active tab’s fill always equals the pane surface so the tab fuses with its content; the strip sits one step behind. Focus is expressed only through the underline and one step of text emphasis — never by tinting an unfocused pane’s surface.

| Token | Light | Dark | Use |
|---|---|---|---|
| `tabbar-bg` | #ECE8E1 | #1B1917 | Tab bar strip. Overflows by horizontal scroll with a 16px mask fade, never a dropdown |
| `tabbar-border` | #D0CABF | #3B3833 | Tab bar bottom border |
| `tab-bg-active` | #F5F2EC | #201E1B | Active tab fill, equal to the pane surface |
| `tab-bg-hover` | rgba(38,35,31,0.05) | rgba(232,228,220,0.06) | Inactive tab hover wash |
| `tab-fg-active-focused` | #26231F | #E8E4DC | Active tab, focused pane |
| `tab-fg-inactive-focused` | #57524B | #B5AFA6 | Inactive tab, focused pane |
| `tab-fg-active-unfocused` | #57524B | #B5AFA6 | Active tab, unfocused pane |
| `tab-fg-inactive-unfocused` | #6A655D | #918B81 | Inactive tab, unfocused pane. The dirty dot inherits this ink at 4.73:1 |
| `tab-indicator-focused` | #4A6DB0 | #7E9CD6 | 2px underline on the focused pane’s active tab — the only accent in chrome at rest |
| `tab-indicator-unfocused` | #B5AFA6 | #57524B | The same underline, desaturated |
| `tab-close-hover-bg` | rgba(38,35,31,0.08) | rgba(232,228,220,0.10) | Close button hover pill. The close glyph itself exists only on hover |
| `tab-lock-fg` | #6A655D | #918B81 | Lock glyph in the trailing slot of a non-closable tab |

### Controls, separators, and drag-and-drop

| Token | Light | Dark | Use |
|---|---|---|---|
| `control-fg` | #57524B | #B5AFA6 | Icon button and block handle idle |
| `control-hover-fg` | #26231F | #E8E4DC | Icon button hover foreground |
| `control-hover-bg` | rgba(38,35,31,0.07) | rgba(232,228,220,0.08) | Icon button and secondary-button hover wash |
| `control-disabled-fg` | #B5AFA6 | #57524B | Icon button disabled |
| `reveal-bg` | rgba(251,249,245,0.92) | rgba(42,39,36,0.92) | Collapsed-sidebar reveal button |
| `separator-idle` | #E2DDD3 | #2E2B27 | Pane resize gutter at rest |
| `separator-hover` | #B5AFA6 | #57524B | Gutter on hover |
| `separator-drag` | #4A6DB0 | #7E9CD6 | Gutter while dragging |
| `drop-fill` | rgba(74,109,176,0.12) | rgba(126,156,214,0.16) | Drop-target fill |
| `drop-border` | #4A6DB0 | #7E9CD6 | Drop-target border |
| `split-preview-fill` | rgba(74,109,176,0.08) | rgba(126,156,214,0.10) | Split-preview overlay fill |
| `split-preview-border` | rgba(74,109,176,0.55) | rgba(126,156,214,0.55) | Split-preview outline |
| `scrollbar-thumb` | rgba(38,35,31,0.28) | rgba(232,228,220,0.22) | Overlay scrollbar thumb, 10px gutter, radius-xs, no track fill, no buttons |
| `scrollbar-thumb-hover` | rgba(38,35,31,0.55) | rgba(232,228,220,0.38) | Thumb on hover and drag. 3.52:1 light, 3.04:1 dark |

### Menus, overlays, and inputs

| Token | Light | Dark | Use |
|---|---|---|---|
| `menu-bg` | #FBF9F5 | #2A2724 | Context menu, popover, and tooltip surface |
| `menu-border` | #D0CABF | #3B3833 | Menu border |
| `menu-item-fg` | #26231F | #E8E4DC | Menu item and tooltip text. 14.87:1 light, 11.71:1 dark on the raised surface |
| `menu-item-hover-bg` | rgba(38,35,31,0.06) | rgba(232,228,220,0.07) | Menu item hover |
| `menu-item-disabled-fg` | #B5AFA6 | #57524B | Disabled item |
| `menu-section-fg` | #6A655D | #918B81 | Small-caps section label |
| `menu-separator` | #E2DDD3 | #2E2B27 | Separator hairline |
| `menu-danger-fg` | #A63430 | #E28E82 | Destructive item and danger button ink. 5.96:1 light, 6.67:1 dark on the pane |
| `menu-danger-hover-bg` | rgba(166,52,48,0.08) | rgba(226,142,130,0.12) | Destructive item hover |
| `overlay-panel-bg` | #FBF9F5 | #2A2724 | Top overlay panel |
| `modal-bg` | #FBF9F5 | #2A2724 | Modal panel over the scrim |
| `input-bg` | #FCFBF8 | #1B1917 | Freestanding input fill. In-grid inputs take the row’s own surface |
| `input-border` | #918B81 | #918B81 | Freestanding input border. One value in both themes: 3.27:1 and 3.02:1 light, 5.19:1 and 4.92:1 dark — the old values failed 1.4.11 at 1.58:1 and 1.50:1. In-grid inputs are borderless |
| `input-border-focus` | #4A6DB0 | #7E9CD6 | Input border focused, plus the halo. 4.94:1 light, 6.36:1 dark |

### Touch scrim

A touch tap on a scrim closes what it covers and presses nothing beneath it. The scrim is only a shadow, so the tap that closes a sheet lands on whatever lies under it: the menu's outside press closes the menu and swallows the click that tap makes (`swallowNextClick` in `web/src/ui/menu.tsx`). A preview over the Alt+A prompt works the same way: a tap outside it closes the preview alone, and the card beneath stays unpicked.

The Alt+A prompt has no scrim on a phone. It fills the screen, and `#suggest-scrim` is hidden under `max-width: 760px` in `web/style.css`, so a tap cannot land on one. Where the scrim shows (a wider screen, pointer or not), a click on it closes the preview and the prompt together. This width rule is the one that decides the prompt's scrim, not `pointer: coarse` itself: a coarse pointer on a wide screen still gets the scrim.

A menu that is open when the Alt+A prompt opens over it leaves a prompt-over-menu entry when it closes, and one back press onto that entry does not reopen the prompt: `onPop` in `web/src/nav-history.ts` steps past it (S-2020). The phone check drives this with Alt+A over the pane menu, a touch tap that closes the menu, and one back press: the `suggest` step of `web/check/phone.mjs`.

### Writing surface and PDF

At rest a citation is ink, not a chip: the fill and border tokens below are hover, focus, and selection states only. The token names carry "hover" rather than "chip" deliberately — a developer holding a token named chip will eventually build a chip. The PDF sheet is not surface-page: in dark theme the writing page goes dark because it is the user’s text, but the sheet stays a dimmed warm white, because a PDF is a fixed artifact and inverting it would lie about the source.

| Token | Light | Dark | Use |
|---|---|---|---|
| `page-rule` | #E2DDD3 | #3B3833 | Horizontal rules, heading dividers, the light rule under a table header |
| `cite-ink` | #3A5A99 | #9AB2E4 | Citations, cross-references, and external links at rest. 6.54:1 light, 7.45:1 dark on the page |
| `cite-hover-bg` | #E3E9F5 | #232E45 | Citation fill on hover, focus, and selection only |
| `cite-hover-border` | #C4D1EC | #2F4A80 | Citation border on hover, focus, and selection only |
| `math-hover-bg` | #ECE8E1 | #2E2B27 | Inline math fill on hover and selection only — never at rest |
| `math-affordance-fg` | #57524B | #B5AFA6 | Math affordance text in chrome contexts. On the page, math ink is text-primary |
| `math-hover-border` | #D0CABF | #3B3833 | Math border on hover and selection only |
| `pdf-viewport-bg` | #E2DDD3 | #111009 | Deck behind pages |
| `pdf-sheet-bg` | #FCFBF8 | #ECE8E1 | The page sheet, dimmed rather than inverted in dark theme |
| `pdf-sheet-fg` | #26231F | #26231F | Ink on the sheet. Fixed in both themes, because the sheet is dimmed rather than inverted — text-primary would invert and put light ink on a light sheet |
| `pdf-sheet-meta-fg` | #6A655D | #6A655D | Page-number and header ink on the sheet. Fixed for the same reason as pdf-sheet-fg |
| `highlight-1 / -2 / -3` | marigold · sky · rose at 0.42 / 0.35 / 0.34 | 0.48 / 0.42 / 0.40 | Annotation washes. Over PDF content they render in multiply, which bounds their contrast cost mathematically |
| `find-match-bg` | rgba(242,194,48,0.40) | rgba(237,186,36,0.28) | Transient find match. Worst case 6.53:1 in dark; over scans, 6.61:1 on very dark paper under multiply |
| `find-match-current-bg` | rgba(242,194,48,0.70) | rgba(237,186,36,0.28) | The current match. Light distinguishes by a heavier wash; dark relies on the ring, since a heavier yellow under light text fails there |
| `find-match-current-ring` | #8A5A10 | #F2C230 | Ring on the current match over known grounds. 4.06:1 light, 9.47:1 dark |
| `find-ring-on-source` | #26231F outside #FCFBF8 | same | The two-tone ring used over PDF content, where the ground is unknown. Provable 3.89:1 floor against any uniform paper |

### Tables, tree, and empty states

| Token | Light | Dark | Use |
|---|---|---|---|
| `table-header-bg` | #ECE8E1 | #1B1917 | Sticky header row in chrome tables. Hairline below, never a scroll shadow |
| `table-header-fg` | #57524B | #B5AFA6 | Header labels |
| `table-border` | #E2DDD3 | #2E2B27 | Grid hairlines. Chrome tables only — document tables rule horizontally |
| `table-row-hover` | rgba(38,35,31,0.04) | rgba(232,228,220,0.05) | Row hover wash |
| `table-row-active-bg` | #E3E9F5 | #232E45 | Selected row |
| `table-row-active-fg` | #26231F | #E8E4DC | Selected row text stays primary |
| `code-bg` | #ECE8E1 | #111009 | Code block fill, on the page and in chrome. Square corners on the page — it sits on paper |
| `code-fg` | #3B3833 | #C6C0B7 | Code block text. Inline code on the page takes text-primary with no fill |
| `tree-row-hover` | rgba(38,35,31,0.05) | rgba(232,228,220,0.06) | Tree row hover |
| `tree-row-selected-bg` | #E3E9F5 | #232E45 | Selected tree row |
| `tree-row-selected-fg` | #26231F | #E8E4DC | Selected tree row text |
| `empty-icon-fg` | #6A655D | #918B81 | Empty-state glyph where one appears at all — bare, never in a tinted container |
| `swatch-border` | #6A655D | #918B81 | Border on annotation color swatches. 5.50:1 light, 4.39:1 dark on the menu surface; the raw marigold alone is 1.59:1, which is why the border is mandatory |

The Agents page's table (S-1432) is a chrome table: rows at `size-row-table`, the sticky `table-header-bg` header with `table-border` hairlines, and a selected row on `table-row-active-bg`. A group line (Machine, ITSA) sits on `table-header-bg` too. Its columns shrink, then drop by priority as the table narrows, so it never scrolls sideways; a long value cuts with an ellipsis and shows in full as its tooltip. The name column keeps at least 200 px at every desk width. The columns drop in this order as the table narrows: age, unread, machine, role and model, then activity and ITSA. `web/check/agents-name.mjs` measures the name column at every width from 1440 down to 761 px, and the drop breakpoints are in `web/style.css`.

The phone Agents list (S-1432) is the page's phone form. Under the header (the title, "N live · N waiting", the legend and Spawn), the scope chips are one row of `.agents-chip` touch targets (`--size-hit-touch` high) that scrolls sideways and never wraps; the chosen scope is the desk's `useAgentsView().scope`. Rows follow the sidebar's tree order from `buildLines`, two lines each at least `--size-hit-touch` high: line 1 is the harness mark in its state ring, the name, and the cost on the right; line 2 is muted, the top wait or the activity, the model, then the ITSA key. A level is 12 px, capped at 3; a deeper row stays at the cap and shows "↳ parent" on line 2. A tap opens the agent. A long press (`--duration-hold`) opens `agentMenu` at the row, and the tap that follows a hold does not fire; a move past the hold slop cancels it, so a scroll never opens a menu. The `⋯` button stays on each row. A row's cost shows its own spend, and a parent also shows its tree's ("own/tree"), as the desk table does; a screen reader hears "own, tree" in `.sr-only` text, and the cost's title gives the full figures. `.sr-only` is the one visually hidden text class. A parent counts as having children in any scope, since its tree spend includes stopped and archived children; the sidebar tree counts live children only. The phone header has no work-columns button, since its rows show no work columns; its legend button stays. Rows are memoised on their props, but the store replaces every agent object when any agent changes, so a change to any agent redraws every row.

The Agents page's scope chips (S-2937) are a `.seg` in the header, after the live count: Live (the default), Waiting, Stopped and Archived, each with its count. The live count in the header stays the live count whatever the scope. Waiting counts the live agents with a permission request open or any wait; the header's "asks or waits" counts the human's waiting list, which is a different count. Archived rows show "archived" as their activity. Stopped and Archived list their agents in the same table; Age shows when such an agent last changed. An archive shows its first 100 rows, then a button pages in the next 100. The scope is kept in the `agentsTableCols` view record. The phone shows the list below.

The Agents page's detail pane (S-3048) is on the desktop's right: `DetailsView` for the picked agent, 420 px (`--size-agents-pane`), with the table on the left. A row is picked by a click or the arrow keys and stays picked through polls and any scope that still lists it. Space shows or hides the pane, not while focus is in a field, and the choice is kept in the `agentsTableCols` record. The pane shows only with a pick (S-3616): with nothing picked the table takes the full width at any window width, and there is no empty pane. With a pick, the pane shows from a 1100 px desk on until the human chooses; a choice to show it opens it at any width, and a choice to hide it (Space) keeps a pick from reopening it. Space with nothing picked does nothing, so it never sets a choice with no visible effect. Below 900 px it lies over the table. Clearing the pick closes the pane at once. The table's columns drop by the table's own width, so the pane narrows them, never the name. The phone keeps its tree.

The Agents page's checked set (S-3117) is apart from the picked row (S-3048): checking rows never changes the detail pane, and a click on a row picks it as before. A checkbox at each row's start checks that row, and `x` checks the picked row. Shift-click checks the rows from the last one checked or picked to this one. The header box checks every row in view, and it is mixed when only some are checked. Esc clears the checked rows, unless focus is in a field. The checked set holds ids only and is kept on the page, not saved: it survives the poll and a re-sort, drops an agent that leaves the scope, the search or the list, and clears on a scope change. Collapsing a tree fold also drops the checked rows it hides, since the table no longer lists them. A press on a checkbox keeps focus where it was, so Esc and the keys still reach the page. The header box and the bar cover only the rows the table shows. With one or more rows checked, the bulk bar sits under the table: `N selected`, Pause, Resume, Archive… and Mode, then Clear. Each action skips the agents it does not apply to, and its button shows how many it applies to ("Pause 3"); a button that applies to none is disabled. Archive and a mode change ask first, in a popover above the bar that names the count and up to five names; the popover holds the checked ids, and each agent is read again when the human confirms. An archive whose parent is also checked is not sent again: the parent's cascade archives it, and it is reported by what the cascade did. Pause and Resume run at once. A bulk action ends with one toast: "Paused 5", or "Paused 4, 1 failed: name (reason)". An archive the daemon queues, because the agent is still running its final step, counts as "1 queued: name". The bar is one row at `--size-row-table` on `--surface-pane`, with a `--table-border` top hairline; a checked row takes `--table-row-hover`. The phone's select mode (S-3282) is the Agents list's own checked set, kept by id as the desk's is. The header's Select, a 44 px target, turns each row into a checkbox in the fold chevron's slot, so no row's text moves; a tap on a row checks it and opens nothing. In select mode the header reads "N selected", then Select all for the rows in view and Done. Back, Esc and Done leave the mode, and the browser history records it as an overlay, so Back closes it and keeps the page. The bar is the desk's `AgentsBulk` (the same counts, eligibility and confirms), fixed on the phone's bottom bar (`--nav-h`, which holds the safe-area inset) at `--surface-pane` with a `--table-border` hairline. The list pads its foot by the bar's measured height, so the last row scrolls clear of it. The bar's buttons are 44 px touch targets. On the phone the bar is one row at 360 px (`compact`): each action is its icon and its count, with its name as its label, and the count and Clear go, since the header carries both. The phone's composer is hidden while select mode is on, and comes back on Done, Back or Esc. A checked row takes `--table-row-hover`.

The Agents page's header ends with a primary Spawn button (S-3182): `.btn.primary` with a plus and the label "Spawn", which opens the spawn menu from its own rectangle. Between the search and the icon buttons, the machines strip shows one item per machine: its name, then a CPU and a RAM meter (the sidebar's `Meter`, with its C and R letters and the labels "CPU 62%" and "RAM 40%"). An offline machine shows its name muted and "off". Hover or keyboard focus opens the sidebar's machine popover, the same one. The header steps down only while it overflows, and each step is measured, never a fixed breakpoint. First the count, the group select and the search give way in CSS: the count shrinks to nothing, the group select to its minimum width, and the search keeps the width its placeholder needs. Then the strip is one icon button, `Machines`, whose dot is the worst level of the online machines (a neutral dot below 80%, warning from 80%, error from 95%) and whose click lists every machine in a popover. Then Spawn is its accent plus alone, `.btn.primary.compact`, labelled "Spawn agent". Then the scope chips become one native `select`, `Scope`, that lists each scope with its count. Last, the page title hides. A step back is taken once the header holds the form back with room to spare. The strip draws from the store's machines list, which changes only when the machines change, so the 5 s agent poll doesn't redraw it. On a phone, Spawn is the header's last item: a 44 px touch target with an accent plus (`--accent-text`), no fill, as the header's other icon buttons take their ink; its hover takes `--accent-subtle`. The primary filled button is for desktop surfaces only. The machines stay in the Agents tab under the tree.

### Status

In-progress deliberately borrows the indigo family: "working" and "interactive" are the same voice. Do not add a separate info blue.

| Token | Light | Dark | Use |
|---|---|---|---|
| `status-neutral-fg / -bg` | #57524B on #E2DDD3 | #B5AFA6 on #2E2B27 | Neutral badge. 5.72:1 light — sand-200, not a raw hex |
| `status-progress-fg / -bg` | #3A5A99 on #E3E9F5 | #9AB2E4 on #232E45 | Saving and loading. Never a spinner, never a skeleton |
| `status-success-fg / -bg` | #3E7040 on #E1EEDF | #93C08F on #243522 | Success |
| `status-warning-fg / -bg` | #8A5A10 on #F6ECD4 | #D9A84E on #3A2E17 | Warning |
| `status-error-fg / -bg` | #A63430 on #F6DEDB | #E28E82 on #3D211E | Error, rendered at the point of failure and never in a toast |

## Contrast

### Method

Every ratio was computed with the WCAG relative-luminance formula, not estimated. AA requires 4.5:1 for normal text and 3:1 for large text and non-text indicators. This policy earned itself twice: the single figure this document once carried as an estimate was also the only wrong one, and a later pass proposed a palette rule that computation showed would have failed on arrival.

### Worst cases

- Light theme text floor: text-muted on surface-app / tabbar-bg at 4.73:1 — AA. The dirty dot inherits this ink and passes non-text at the same value.
- Dark theme text floor: text-muted on surface-page at 4.69:1 — AA.
- Solid accent fills: text-on-accent on accent at 4.94:1 light, 6.31:1 dark — AA.
- Citation ink at rest: 6.54:1 on the light page, 7.45:1 on the dark page.
- Danger ink: 5.96:1 light, 6.67:1 dark on the pane.
- Tooltip and menu text on the raised surface: 14.87:1 light, 11.71:1 dark.
- Redefined input border as a non-text boundary: 3.02:1 at worst (light, against the pane), 4.92:1 at worst in dark.
- Focused-block margin bar as a non-text indicator: 4.58:1 at worst (light pane), 6.03:1 at best.
- Annotation swatch borders: 5.50:1 light, 4.39:1 dark.
- Find matches on known grounds: 12.40:1 at best, 6.53:1 at worst.
- Find and highlight washes over scanned PDFs under multiply: black ink holds 14.16:1 on clean paper, 10.92:1 aged, 8.54:1 on a dark scan, 6.61:1 on a very dark scan; mid-gray ink holds 3.70:1 even there. The current-match wash holds 12.07:1 on clean paper and 7.40:1 on a dark scan.
- The two-tone ring over unknown paper: a provable 3.89:1 floor against any uniform ground, since for a tone pair whose mutual ratio is 15.11 at least one tone must exceed its square root.

### Exemptions

Four deliberate exemptions, stated rather than smuggled. text-disabled and empty-icon-fg are sub-AA by design; disabled states and decorative glyphs are WCAG-exempt. Scrollbar thumbs are sub-3:1 at rest (1.77:1 light, 1.88:1 dark), matching every native overlay scrollbar, on the grounds that thumb position is redundant with visible content position — the hover and drag state does pass at 3.52:1 and 3.04:1. The drag-source dims to 50% opacity, which is transient and exempt on the same footing as disabled. The secondary button’s hairline border sits below 3:1 deliberately: per WCAG 1.4.11 a control identified by its own AA-passing text label does not require its decorative boundary to pass. Tab close and lock glyphs inherit their tab’s already-verified foreground.

## Typography

### Chrome

**Face:** Source Sans 3 Variable, self-hosted

#### Rationale

- Drawn by Adobe as a user-interface typeface — their first open-source release, made for legibility at small sizes in interface text.
- Tabular figures are not merely available but the default: measured from the binary, all ten digits carry identical advance widths (497/1000), with proportional figures exposed as the alternate. The reference table’s column alignment therefore survives even aggressive subsetting — a dependency the system inspected and found it does not have.
- One variable woff2 per style covers 400/500/600, taken from Adobe’s own npm package and served locally. Never a font CDN: a local-first research tool should not phone out to render its own chrome.
- It is the design sibling of Source Code Pro, already the monospace, so chrome text and chrome code become one drawing system — the same argument this document makes for matching icon stroke weight to label stem weight. Superfamily pairing is the classic typographic move for coherence, and it is checkable rather than a matter of taste.
- It carries true small caps, so section labels become genuine small caps rather than tracked uppercase — the typographically correct form of that role and the scholarly convention for running labels. This is the reason the package matters as much as the typeface: the Google-pipeline build of the same family was measured to carry no smcp at all, while Adobe’s carries smcp, c2sc, sups, case, and zero. The keep-list then stops the build from losing them, which is a different job from having them.
- The alternative was Inter, the default UI sans of the last decade. Every functional claim for Inter is equally true here, and when two faces tie on function the tiebreakers are coherence and the fact that "timeless" and "the face every dashboard of the 2020s shipped with" cannot both hold.

#### Stack

'Source Sans 3 Variable', 'Source Sans 3', ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif

#### Default size

The chrome default is 13px, not 12px. Legibility research on critical print size (Legge and Bigelow, Journal of Vision, 2011) shows reading speed falls off below roughly 0.2° of x-height visual angle; at typical laptop viewing distance 13px keeps chrome text clear of that threshold while 12px sits at its edge. 12px is reserved for the reference table, 11px for labels that are scanned rather than read.

#### Weights

regular 400, medium 500, semibold 600. 700 is banned in chrome — in a quiet room, semibold is the loudest voice anything gets.

#### Scale

| Token | Value | Use |
|---|---|---|
| `type-chrome-xs` | 11px / 14px | Badges, menu section labels, empty-state eyebrow. Small caps, +0.04em |
| `type-chrome-sm` | 12px / 16px | Table cells and headers, secondary metadata, the sticky document context line |
| `type-chrome-md` | 13px / 20px | Default: tab labels, tree rows, menu items, inputs, buttons, pane headers, the document outline |
| `type-chrome-lg` | 14px / 20px | Rare emphasis inside chrome |
| `type-chrome-xl` | 16px / 24px | Empty-state headings, modal titles. −0.01em |

#### Roles

| Role | Spec | Note |
|---|---|---|
| Tab label | 13px / 400 / sentence | Active stays 400. Signalled by color plus a 2px underline — a weight change alters tab width and makes the bar jitter on every switch |
| Pane header | 13px / 600 / sentence | Not uppercase |
| Menu item | 13px / 400 / sentence | Shortcut hint at the same size in text-muted with tabular figures, never a boxed keycap |
| Menu section label | 11px / 500 / small caps | +0.04em tracking; falls back to tracked uppercase if the feature is ever stripped |
| Tree row | 13px / 400 / as-is | Never italicize or shrink filenames; status is carried by color and glyph, not type |
| Table cell | 12px / 400 / as-is | Tabular figures, which are the face’s default |
| Table header | 12px / 500 / sentence | Not uppercase: twenty columns of caps is noise, not order |
| Button | 13px / 500 / sentence | 28px height, 12px horizontal padding, radius-sm |
| Badge | 11px / 500 / sentence | 2px 6px padding, radius-xs. Never a count in a red circle |
| Tooltip | 12px / 400 / sentence | 4px 8px padding, no arrow — an arrow is a speech bubble, and instruments do not speak |
| Document outline | 13px / 400 / 24px rows | 12px indent per level; current section marked by a 2px accent bar — the same marker as the focused block, so "where you are" reads the same everywhere |
| Document context line | 12px / 400 / text-secondary | The on-screen substitute for a running head, sticky, hairline rule below, no shadow. Save state and save failures render here |
| Empty-state eyebrow / heading / body | 11px 500 small caps / 16px 600 / 13px 400 | Body capped near 40ch, at most one action, no icon by default |
| Input and inline rename | 13px / 400 / as-is | Inline rename must be pixel-identical to the tree row so entering rename mode does not shift the filename |

### Document

**Face:** STIX Two Text Variable, self-hosted, with the true italic companion

#### Rationale

- It is the only open typeface commissioned by scientific publishers for scientific publishing. The STI Pub consortium — the American Chemical Society, AIP, the American Mathematical Society, APS, Elsevier, and IEEE — funded it as a Times-lineage face for exactly this content. The question "what face would a scientific manuscript choose?" has a literal answer.
- It has a designed math companion with LaTeX and unicode-math support. This product’s documents carry math and its export target is LaTeX, so text and math can be set in faces drawn against each other. This was the decisive argument: the alternative had no math font at all, so every export would pair it with math it was never designed against.
- On screen, KaTeX renders variables in Computer Modern-derived italics — Times-plane letterforms. Scientific prose toggles constantly between prose italic and math italic, a species name in one clause and a variable in the next, and a body italic from the same broad lineage sits beside them rather than arguing with them.
- Scientists spend their reading lives inside Elsevier, IEEE, and APS pages set in this lineage. The manuscript pane reads as a journal article rather than as a well-set blog post.
- Its metric fallback is Times New Roman, installed effectively everywhere, so a failed webfont load barely reflows. True italics ship alongside it, because letting the browser oblique the roman is disqualifying for italic-heavy scientific prose.
- Headings use the same family. Scientific papers set headings in the text face at higher weight; a contrasting heading sans is the fastest way to make a manuscript look like a marketing page.
- Like the chrome face, its figures are tabular by default — measured at 495/1000 across all ten digits at weight 400 — so document tables align without depending on a feature surviving the build.
- It ships in two pieces under one family name. The published text face covers Latin and Greek only; the symbols scientific prose actually uses — ≤ ≈ ≠ → ↔ ∗ † ‡ ′ ∞ ∑ ∫ √ ∈ ⟨⟩ Å ℃ ℓ № and the fi/fl ligatures — come from STIX Two Math, subset to exactly the codepoints the text face lacks and declared with a unicode-range generated from the emitted file rather than hand-written. This satisfies REQ-SHELL-VIS-GLYPH-COVERAGE, and it is the designed-math-companion argument paying a dividend the face was not chosen for: because the two were drawn against each other, a symbol in running prose is set in the same typeface as the words around it instead of falling through to Times.

#### Body

| Token | Value | Use |
|---|---|---|
| `doc-size-body` | 17px | Measured: STIX’s x-height of 0.473em gives an 8.04px body x-height, the smallest size that clearly exceeds 16px chrome text at 7.78px. Below it the manuscript would read smaller than the instrument panel, inverting the system’s hierarchy |
| `doc-leading-body` | 1.6 | Generous for a concrete reason: inline math is taller than text, and at 1.5 adjacent lines collide with rendered fractions |
| `doc-measure` | 75ch | 631px at 17px, using the measured digit advance of 0.495em — the top of the 45–75 character range for continuous reading, so the widest defensible column at this body size. Tables, figures, and block math may escape it; running text never does. Chrome never enters it: a control that belongs to a block — a drag handle, a menu affordance — hangs in the margin or overlays the block, so the measure is content and what centres on the page is the writing rather than the writing plus its instruments |
| `doc-measure-min` | 45ch | The floor the measure narrows to and no further. A digital-native document is bound by no page, so its column follows the pane down — but only to the bottom of the same 45–75 character range, below which the pane scrolls rather than the line getting shorter. Expressed in ch so it tracks the body size, and therefore the view’s zoom, without being restated. A paged document never reaches it: a page holds its own width and scrolls. Outside the override contract — no document declares it |
| `doc-para-space` | 0.75em | Space between block paragraphs, the editing default |
| `doc-para-indent` | 0 | First-line indent. Set to 1.5em for typeset manuscripts, which collapses paragraph space toward 0 and sets the first paragraph after any heading flush |

#### Headings

Sized in em relative to doc-size-body so a document override rescales the whole hierarchy for free: h1 1.6em/600, h2 1.35em/600, h3 1.15em/600, h4 1em/600, h5 1em/400 italic, h6 1em/500 italic. Deliberately shallow — a paper’s h1 is a title, not a hero — and the bottom converges to body size differentiated by style, exactly how print journals handle deep nesting. Space before is always at least twice space after, so headings bind to the text they introduce. Section numbers are content supplied by WCS; the system sets them in the heading’s own size and weight with a 0.6em gap and no terminal point — "2.1 Methods", not "2.1. Methods" — per ISO 2145, the international standard for numbering document divisions.

#### Math and code

Inline code sits at 0.875em because monospace runs optically large and 1em code bulges out of a serif line; on the page it is monospace ink with no fill and no pill, ever. Code blocks take the code-bg fill with square corners at full measure — the fill is sanctioned because tinted code panels are established print practice, and this is the boundary case proving at-rest-is-print is about print precedent rather than the absence of ink. Math renders at exactly 1em of the surrounding body and is never scaled down; block math centers within the measure, scrolls horizontally before it ever shrinks, and takes its equation number flush right in roman parentheses.

#### Output intent

A document declares its intended output once, and both the writing surface and the export check follow from it. An intent of digital reading is bound by no page: it shows the reading measure, which follows the pane down to doc-measure-min and no further. An intent of a page shows that page at its real size — the real paper, the real margins, the real point size — and a pane too narrow for it scrolls rather than shrinking it, so where a block stops fitting is a fact about the page rather than about the window. What size either one appears at on screen is the view’s zoom, which is neither a token nor a declaration: it multiplies the geometry the document already states, belongs to the view, and reaches no export. Page geometry is document-scope vocabulary alongside the eight — page size, margins, column count, and column gap — and either the geometry or the target the interface checks a property against may be declared against the intent rather than restated. This is what makes REQ-WCS-EDIT-WYSIWYG answerable: "what the editor shows matches rendered output" needs a statement of which rendered output, and the intent is it. Per-venue document classes stay template work, as printExport says; the intent selects a geometry, not a journal.

#### Paragraphs

Block paragraphs with space between them remain the editing default: the paragraph is the unit of manipulation and whitespace marks block boundaries unambiguously. But first-line indentation with no inter-paragraph space is the dominant convention of typeset scientific prose — effectively every journal, every university press, and the LaTeX default — so the system must be able to represent it. That is what doc-para-indent is for. The default does not flip; the capability was what was missing.

### Override contract

**Requirement:** REQ-WCS-STYLE-DOCUMENT

#### Framing

This stopped being a capability boundary and became a disclosure order. REQ-WCS-STYLE-CASCADE and REQ-WCS-STYLE-SAVED let a writer declare any property in the vocabulary at any scope the property is legal at, so a list of what a document may not touch no longer describes what the product permits. What the list still describes correctly is what the product should put in front of a writer first, and what it should warn about when they go looking for the rest. Read mayOverride as tier one and mayNotOverride as the advisories attached to the controls it used to forbid.

#### Tiers

- common — the eight below. Shown at rest in the inspector and reachable from the selection bar. Overriding these restyles the document coherently, because headings, apparatus, code, and math are all em-derived from doc-size-body.
- more — the rest of the document-scope and block-scope vocabulary, behind one disclosure. No advisory: these are ordinary typographic decisions that happen not to be needed often.
- advanced — every property carrying a system consequence, behind a second disclosure. Each one shows a mandatory one-sentence advisory in muted type beside the control, taken from the list of advisories, because the consequence it states is a system consequence rather than a WCS one.

#### May override

- doc-font-body
- doc-font-heading
- doc-font-mono
- doc-size-body
- doc-leading-body
- doc-measure
- doc-para-space
- doc-para-indent

#### May not override

- Any chrome token. The inverse of REQ-SHELL-VIS-CHROME-VS-DOCUMENT holds too: no serif in chrome, ever.
- Color, surface, and focus tokens — theme integrity is not a per-document decision.
- The math-at-1em rule.
- Selection, highlight, and find-match rendering.
- Heading ratios. A document needing different ratios is a template concern, not a style override.
- Apparatus proportions — caption, note, and quotation sizes and indents. These are the system’s, not the document’s, and they rescale automatically because they are em-derived.
- Shell spacing and density.

#### Cap

Eight is a cap on what the inspector shows at rest, not on what a writer may declare. Notion restyles an entire page with effectively three controls, which is the strongest available evidence that the surface a writer meets first wants a handful of values rather than a full property list. The cap therefore survives the cascade intact — it moved from governing the model to governing the disclosure, which is where it was always doing its work. Because headings, apparatus, code, and math are all em-derived from doc-size-body, overriding these eight restyles the document coherently rather than piecewise.

#### Advisories

Each entry below is the advisory shown beside the control it names, in the advanced tier. The wording is the wording that used to state a prohibition, because the reason it gave was always a real consequence and stating the consequence is what the writer needs. Two of them are not advisories but still boundaries: no chrome token is addressable from a document at all, and the theme stays the system’s, so neither appears as a control to advise on.

#### Unmoved

The token layer gains nothing from the cascade. Block width still derives from the measure, block and run sizes are still ratios of the body size, and the advanced properties resolve to CSS rather than to new tokens. A vocabulary of 56 properties resolving through a chain is not 56 more tokens; it is one resolution reading the tokens that exist.

#### Export

Six of the eight round-trip through export: the three font tokens via a total family-to-package table, plus measure, paragraph space, and paragraph indent, which map onto LaTeX primitives directly. Body size and leading never export — screen reading size is an ergonomic of this glass, not a property of the manuscript, and pushing 17px into a 10pt document class would be a category error. The six live in the document’s front matter, which markdown preserves verbatim and LaTeX writes as a tagged preamble block that import parses back.

## Scholarly apparatus

A scientific paper is at least half apparatus. A system that specifies body, headings, code, and math and stops there has specified prose in a serif, not a manuscript — the first real paper pasted into it hits undesigned territory within the first page. Rigor in a document is expressed through exactly this apparatus. Everything below is em-derived from doc-size-body, so the override contract rescales it automatically, and nothing below introduces a new hue.

### Figure and table captions

Captions sit below figures and above tables — the classic asymmetric rule, followed by Chicago and effectively every publisher. Set at doc-size-caption with line-height 1.45, ragged right, and capped at the object’s width rather than the full measure. The label ("Figure 3." / "Table 1.") is weight 600 roman and runs into the caption text at 400, the near-universal journal convention. Spacing binds the caption to its object: 0.5em from the object, twice doc-para-space from the following prose.

### Tables on the page

The most recognizable typographic marker of a scientific table is the booktabs rule set, and it is a checkable convention rather than a preference: horizontal rules only — a heavier rule above and below the table and a light rule under the header row — with no vertical rules and no zebra striping. The heavy rule is 1px text-primary, because a printed rule is ink; the light rule is 1px page-rule. Body text at 0.875em with tabular figures, which are the face’s default. Header row weight 600 roman, not caps. Zebra striping is dashboard grammar and is banned on the page; chrome tables such as the reference manager are instruments and keep their own grid, which is the chrome/document distinction doing its job.

### Footnotes and endnotes

A scrolling editor has no page bottom, so notes are structurally endnotes and the marker is the interactive element. Markers are superscript numerals using true superior figures where the build preserves them and synthesized at 0.65em raised otherwise — both renderings are specified, so neither is a risk. Note text sits at doc-size-note with line-height 1.5, numbered in tabular figures with a hanging indent so wrapped lines clear the numbers. A marker may preview its note in a chrome popover on hover or click; the popover is chrome and uses chrome tokens, while the note text itself remains document territory.

### Block quotations

Indented doc-indent-quote on both sides at doc-size-quote, roman — never italic, with no added quotation marks and no left border bar. Print has set extracts by indentation and a slight size drop since before typewriters; the border-left blockquote is Markdown-web vernacular. This is stated as a prohibition because every developer’s muscle memory will reach for the bar.

### Lists

Markers follow the export target’s convention: level one •, level two –, level three ∗, in text-primary. Numbered lists set numerals in tabular figures with a terminal period, hanging-indented at doc-indent-hanging so wrapped lines clear the numbers. Adjacency governs their spacing: items within a list sit at 0.25em while the list as a whole takes doc-para-space from surrounding prose — this is the rhythmic-calm rule made concrete, and future block types inherit it. In indent mode, lists keep block spacing and are never first-line indented.

### Bibliography and reference list

The hanging indent is to a reference list what booktabs is to a table — the instantly-read marker of scholarly setting. Author–date styles set the first line flush and wrap at doc-indent-hanging. Numeric styles set the label flush left in tabular figures with entry text block-indented to a constant column. Entries at 0.9375em, line-height 1.5, 0.5em between them. Never bullets, never cards, never boxes: a reference list rendered as a card stack would be the loudest dashboard tell the product could emit.

### Citations, cross-references, and links

One rendering rule for all three, and it is at-rest-is-print applied: colored ink, no decoration. "Figure 3", "Section 2.1", "Eq. (4)", "(Borgen, 2026)", and external links all take cite-ink. One interactive-ink color matches the system’s one-accent discipline — LaTeX’s hyperref distinguishes link classes by color and its defaults are widely considered a disfigurement; the single-color discipline is the deliberate corrective. The page never shows a pointer cursor at rest; citation ink shows one on hover, which is exactly the moment interactivity is real.

### Figures, block selection, and the outline

Figures center at up to the measure’s width, may escape to page width when intrinsically wider, take square corners and no border, and carry their caption below. Block selection renders as selection-bg across the selected blocks’ full line boxes — the same token as text selection, because block selection is selection. The living outline is an instrument rather than page content, so it renders in chrome type with the current section marked by the same 2px bar the focused block uses; dot leaders exist only where page numbers exist, which means only in paginated export. On screen the running head’s job belongs to the sticky context line; paginated export gets true running heads at 0.8em small caps with folios in tabular figures.

### Apparatus tokens

Theme-invariant and outside the override contract: apparatus proportions belong to the system, not to the document. They rescale with the document anyway, because they are em-derived.

| Token | Value | Use |
|---|---|---|
| `doc-size-caption` | 0.875em | Figure and table captions |
| `doc-size-note` | 0.875em | Footnote and endnote text |
| `doc-size-quote` | 0.9375em | Block quotations |
| `doc-indent-quote` | 1.5em | Block quotation indent, both sides |
| `doc-indent-hanging` | 1.5em | Bibliography, numbered lists, and note hanging indent |
| `doc-space-adjacent` | 0.25em | Spacing between adjacent items of the same kind, such as list items |

## Space, density, radius, elevation

### Spacing scale

Base unit 4px, with one sub-step at 6px for icon-to-label gaps — the most-used gap in the app.

| Token | Value | Use |
|---|---|---|
| `space-05` | 2px | Tightest gaps: badge padding-y |
| `space-1` | 4px | Menu vertical padding, tooltip padding-y, stacked badge gaps |
| `space-15` | 6px | Icon-to-label gap |
| `space-2` | 8px | Intra-group gaps, input padding-y, tooltip padding-x, modal button gaps |
| `space-3` | 12px | Pane content padding, tab padding-x, button and input padding-x, tree indent per level |
| `space-4` | 16px | Between groups within a pane |
| `space-5` | 20px | Large form gaps |
| `space-6` | 24px | Modal padding, empty-state internal gaps, minimum page side padding |
| `space-8` | 32px | Empty-state block separation |
| `space-12` | 48px | Modal top offset, page-level breathing |

### Density

Dense chrome, generous manuscript. Every interactive target meets the WCAG 2.2 minimum of 24×24px, reconciled with density by one rule: the glyph stays small, the padding is the target, and the full row is always the hit area.

| Token | Value | Use |
|---|---|---|
| `size-tab-bar` | 36px | 20px label line plus 8px above and below, so the 2px active underline does not crowd the label. Measured on the running shell it is 7.5px either side: the bar is border-box and 1px of the 36px goes to its bottom border, leaving a 35px content box that the tabs fill. Tabs never shrink below 96px. Horizontally the strip is flush with the bar’s leading edge and only the trailing actions take space-2, since tabs focus with the inset ring and the action buttons focus with the halo. The bar must not carry a gap: dockview always renders an empty pre-actions and left-actions container, and a gap gives each of them 8px of the bar even at zero width — which is where 8 of the original 16px leading inset came from |
| `size-row-tree` | 24px | Dense enough for a sixty-file project without scrolling, and exactly the WCAG minimum because the full row is the target |
| `size-row-table` | 28px | Hosts the 16px cell line with 6px above and below — room for descenders and the 4px inset focus ring without collision |
| `size-row-menu` | 28px | Menus are transient and targeted from a distance, so they get 4px more than tree rows |
| `size-control` | 28px | Buttons and freestanding inputs |
| `size-hit-min` | 24px | Floor for any freestanding interactive element |
| `size-pane-min` | 240px | Minimum pane width; the shell refuses splits that would go below it |
| `pad-pane` | 12px | Default pane padding. Tree and table panes are full-bleed horizontally so hover and selection run edge-to-edge; document and PDF panes take 0 and own their interiors |
| `pad-page-block` | 64px top, 96px bottom | Writing page interior |
| `pad-page-inline` | clamp(24px, 8%, 56px) | Writing page sides — a continuous ramp with no jump, landing at 56px on a common 700px pane |
| `width-page-collapse` | 679px | Below this pane width the sheet runs flush, drops its shadow, fixes side padding at 24px, and the measure yields. Derived: 75ch is 631px, plus 24px of padding each side. Asked of the pane through a container query, since a container query condition cannot read a custom property, the stylesheet repeats the number and this token is where it is derived |

### Radius

Print is square, gloss is round. Radius grows only with detachment from the desk — a physical rule rather than a fashionable one. Nothing exceeds 8px, no pill shapes anywhere, and the page is never rounded.

| Token | Value | Use |
|---|---|---|
| `radius-none` | 0 | The document page, PDF page, and page code blocks — paper is cut square. Tabs at rest, panes, sidebars, world boundaries |
| `radius-xs` | 2px | Badges, checkboxes, highlights, scrollbar thumbs, annotation swatches, selection rectangles inside dense grids |
| `radius-sm` | 4px | Buttons, inputs, rename fields, tooltips, menu and tree selection fills, tab drag ghost |
| `radius-md` | 6px | Context menus, popovers, dropdowns — the first tier of things that float |
| `radius-lg` | 8px | Modal panels and the top overlay panel. This is the ceiling |

### Z-index scale

Sparse by 100 so a layer can be inserted without renumbering. Popovers outrank modals because a modal’s own controls spawn menus, and a popover is always the most transient layer alive. That is not a dismissal strategy: opening a modal must close open popovers in code.

| Token | Value | Use |
|---|---|---|
| `z-base` | 0 | Pane content, document, PDF, table body |
| `z-sticky` | 100 | Sticky table headers, tab bars, the document context line |
| `z-reveal` | 200 | Collapsed-sidebar reveal button |
| `z-drag` | 300 | Tab drag ghost, drop-zone overlays, split previews |
| `z-top-overlay` | 400 | The top overlay world |
| `z-scrim` | 500 | Modal scrim |
| `z-modal` | 600 | Modal panel |
| `z-popover` | 700 | Context menus, dropdowns, tooltips, footnote previews, the annotation toolbar |

### Shadow assignment

- shadow-page — document and PDF pages at rest. The only always-on shadow in the app: a sheet of paper lying on the desk. Dropped when the sheet collapses at narrow widths, because a flush sheet is not lying on anything.
- shadow-float — near-floaters that stay attached to their origin: context menus, popovers, tooltips, dropdowns, the drag ghost. It is named for what uses it, not for panes, because a token named after the one element class forbidden to use it is a misuse generator.
- shadow-raised — fully detached layers: the modal panel and the top overlay panel.
- No shadow at all — sticky headers (a hairline border instead; a scroll shadow under a sticky header is the glossiest cliché in dashboards), panes at rest, the reveal button, and drop-target previews, which are diagrams rather than objects.

## Motion

### Motion

Motion confirms causality; it never performs. It exists for exactly two purposes: making a spatial change traceable, and softening the arrival of transient surfaces. Everything on the reading and typing path is instant, always.

| Token | Value | Use |
|---|---|---|
| `duration-fast` | 80ms | Hover and active fades, control reveal-in, reveal fade-out, drop-preview fade-in |
| `duration-base` | 140ms | Menu and popover entrance, sidebar reveal fade-in, badge cross-fade |
| `duration-slow` | 220ms | Sidebar collapse and expand, modal entrance |
| `ease-out` | cubic-bezier(0.2, 0, 0, 1) | All entrances — fast start, settled landing |
| `ease-in` | cubic-bezier(0.3, 0, 1, 1) | Exits, one duration step faster than the entrance |
| `ease-in-out` | cubic-bezier(0.45, 0, 0.25, 1) | Layout size changes only |

### Reveal contract

Controls that materialize on approach — tab close buttons, row actions, the block handle, the annotation toolbar — fade in at duration-fast and vanish at 0ms, the same asymmetry as menu exits. Reveal is triggered by hover or focus-within, never by proximity alone except for the collapsed-sidebar button, which has no element to hover. At rest an element shows state glyphs and never controls. Stating the timing here is what stops each implementer from choosing their own. A selection-triggered control is the same contract with a different trigger: the style bar exists while a selection does and vanishes with it, in at duration-fast and out at 0ms. A selection is an approach the pointer has already finished making, so it reveals on the same asymmetry rather than acquiring a timing of its own.

### Never animated

- The caret, text selection, and any typing-induced reflow.
- Scrolling. No smooth-scroll hijacking anywhere, including scroll-to-heading.
- Tab switching. The content swap is instant and the underline does not slide.
- Tree expand/collapse and table sorting. Dense-data manipulation at IDE speed cannot wait 200ms per disclosure.
- Drag movement. The ghost tracks the pointer 1:1 with no smoothing; previews may fade in but reposition instantly.
- The focus ring, ever. A keyboard user’s place marker cannot lag their keystrokes.
- Menu and control exits, which are 0ms. A fading menu blocks content the user has already decided to act on.
- PDF page rendering and document block insertion.
- Skeleton screens and shimmer, banned outright rather than merely un-animated. Loading is signalled by the progress badge and content appears when it is real — the gray-bones shimmer is the most precisely datable loading pattern of the 2020s, and in a reading instrument a false page is worse than a brief empty one.

## Focus

### Geometry

Ring width 2px at 2px offset, produced by the halo: box-shadow: 0 0 0 2px var(--focus-halo-surface, var(--surface-app)), 0 0 0 4px var(--focus-ring). Because box-shadow follows the element’s own border-radius, the ring’s corner radius is element radius plus 2px by construction — there are no separate focus radius tokens and no outline-radius hacks. Only :focus-visible paints a ring; pointer clicks never do. Exactly one ring is alive in the app at any moment.

### Modes

- Halo (default) — buttons, inputs, icon buttons, menu triggers: any freestanding control with clear space around it.
- Inset ring — dense grids where neighbors touch and an outer halo would be clipped or overlap: table cells, tree rows, tabs. Costs 4px of a 28px row’s interior for the duration of keyboard traversal, which is preferable to halos striping the grid.
- Offset outline — page-scale elements where a halo is visually heavy and expensive to paint: a PDF page, a selected annotation, a pane focused for keyboard navigation.

### Block marker

A focused document block is the exception, and it takes the margin bar rather than any ring: 2px accent, 12px left of the text column, spanning the block’s line boxes, and present only during block-level operations — selection, keyboard block navigation, drag, or an open block menu. During ordinary typing nothing marks the block, because the caret is the marker and outlining every paragraph the caret enters would make writing feel inspected. The bar lives in the margin, so the printed area of the page never changes, and it is the same marker the outline uses for the current section.

### Versus selection

Focus is where keyboard input lands: exactly one place, marked by the ring, gone when the keyboard leaves. Selection is what commands operate on: possibly many places, marked by fill, persistent across focus changes. A row can be selected and not focused, focused and not selected, or both. Fill and ring are different channels and never merge.

## Icons

### Rule

Lucide is drawn on a 24px grid at stroke-width 2, which scales with render size — at 16px the effective stroke is 1.33px and at 14px it is 1.17px, so icons get thinner and less uniform exactly as chrome gets denser. Every icon therefore uses absoluteStrokeWidth at 1.5px, chosen to match the stem weight of the chrome face at 13px/400 so icons and labels read as one drawing system. Wrap it in a single Icon component so no call site can drift.

### Sizes

| Token | Value | Use |
|---|---|---|
| `icon-xs` | 14px | Inline with 11–12px text: badges, table cells, the tab close and lock glyphs |
| `icon-sm` | 16px | Default: tree rows, tabs, menu items, icon buttons, block handles, disclosure chevrons |
| `icon-md` | 20px | Sparingly: primary toolbar actions |
| `icon-xl` | 32px | Empty states only, as a bare glyph |
| `icon-stroke` | 1.5px | Absolute, at every size |

### Alignment

Icons never sit on the text baseline; they center in the row’s line box via flex with a 6px gap. Icons inherit currentColor always — an icon whose color is set independently of its label is a bug. 18px, 22px, and 24px are banned: a two-size chrome is most of what makes an icon system look engineered rather than assembled.

## State vocabulary

**Requirement:** REQ-SHELL-VIS-STATE

### Principle

Each state owns exactly one channel, and no two states share a channel. Because the channels are independent, every legal combination composes without collision — a tab can be active, locked, and dirty at once and each state stays legible. This is the rule that makes a state vocabulary a system rather than a list.

### States

#### The complete state vocabulary

| Token | Value | Use |
|---|---|---|
| `hover` | wash | Translucent rgba wash of the opposite pole. Never opaque, so it works on any surface without per-surface variants |
| `selected` | fill | accent-subtle fill with text-primary ink. Persists when the pane loses focus, because selection is what commands operate on |
| `active` | surface + indicator | The element fuses with its content’s surface plus the 2px indicator — underline for tabs, left bar for outline and blocks. Active means the one whose content is shown |
| `focused (keyboard)` | ring | The three ring modes. Exactly one alive per app, :focus-visible only, never persists |
| `focused (pane)` | ink step + indicator color | The tab ink matrix; the accent underline is the only accent at rest |
| `locked` | glyph | Lock glyph at icon-xs in the trailing slot, replacing the affordance the lock forbids. Never a tint, never a wash — a lock is a fact, not a mood |
| `dirty` | glyph | A 6px dot in the trailing slot, drawn in currentColor so it inherits the element’s already-verified ink. Worst case 4.73:1 light, 5.19:1 dark — passes non-text everywhere without a new token |
| `disabled` | ink | text-disabled or control-disabled-fg, no hover wash, default cursor. The stated sub-AA exemption |
| `loading` | badge | The status-progress badge. Never a skeleton, never a spinner |
| `error` | badge + ink | status-error badge at the point of failure; error ink only inside the failed element, never spreading to its container |
| `drag-source` | opacity | The source dims to 50% in place while its ghost tracks the pointer. Transient, and contrast-exempt like disabled |
| `drop-target` | fill + border | drop-fill, drop-border, and the split-preview tokens |

### Trailing slot

Tabs, and any element with one trailing slot, render exactly one glyph there so width never jitters. At rest the order is dirty dot, then lock glyph, then empty — unsaved work outranks unclosable-ness, because at rest you need to know "unsaved" more than "why is there no close button". On hover it becomes the close glyph if closable, otherwise the lock: the moment you approach to act, the element tells you which action exists. A locked dirty tab therefore shows its dot at rest and reveals its lock on approach.

### Composition

- Dirty is artifact-level, not view-level. Every tab viewing the artifact shows the dot simultaneously, and saving clears them all in one paint — which is the visible proof of the durable-versus-transient split REQ-SYS-ARTIFACT-MULTIVIEW requires.
- Error never enters the tab. A tab whose content failed stays typographically normal and the failure renders inside the pane, because the tab’s glyph channel is already occupied by dirty and lock, and per the channel rule error may not share it.
- Multi-view differentiation is not a state but a label: additional views append "· 2", "· 3" in text-muted, the numeral in tabular figures, no parentheses and no icon. Ordinals are stable for the life of the view.

## Components

### Buttons

28px height, 12px horizontal padding, radius-sm, 13px/500 label, icon at icon-sm with the 6px gap. Primary takes the accent fill with text-on-accent, hovering to accent-strong, and there is at most one primary per surface. Secondary is transparent with a border-default hairline and control-fg label, hovering with the control wash — its border sits below 3:1 deliberately, because WCAG 1.4.11 does not require a decorative boundary on a control already identified by an AA-passing label. Danger takes secondary geometry with danger ink at 5.96:1 light and 6.67:1 dark; solid rust fills are reserved for a confirmation modal’s primary action. Text buttons drop the border and take accent-text, for inline actions in empty states and the context line. Disabled keeps the border, drops the fill and wash, and takes text-disabled.

### Inputs

Two classes, because one border value cannot serve both duties. In-grid inputs — table cells and inline rename — are borderless: the grid supplies the geometry, the inset focus ring supplies the edit state, and rename stays pixel-identical to its row. Freestanding inputs — the find bar, modal fields — must announce their interior, which is exactly the case WCAG 1.4.11 makes load-bearing, so input-border is sand-500 in both themes at 3.02:1 worst rather than the old values that computed to 1.58:1 and 1.50:1. The persona reading is a bonus: a printed form rules its blanks in real ink, and now so does this one. Focus swaps the border to accent plus the halo. 28px, radius-sm, 13px/400, placeholder in text-muted.

### Tooltips

surface-raised fill, border-default, shadow-float, radius-sm, 12px/400 text-primary at 14.87:1 light and 11.71:1 dark, padding 4px 8px, z-popover. Shortcut hints inside follow the menu rule — same size, text-muted, tabular figures, never boxed keycaps. Timing is a 600ms delay on first hover, 0ms for successive tooltips in the same group, and 0ms exit. No arrow: an arrow is a speech bubble, and instruments do not speak.

### Checkboxes and badges

Checkboxes are 14px, radius-xs, input-border idle, accent fill with a text-on-accent glyph when checked. Toggle switches are banned outright — the switch is mobile-app grammar, and paper forms have checkboxes. Badges are 11px/500 at 2px 6px padding, radius-xs, taking the status token pairs; a count badge is neutral unless the count itself is a status, and counts never appear in red circles.

### Modals and menus

Modals are 480px by default and at most 90vw, radius-lg, shadow-raised, modal-bg, padding space-6, title at type-chrome-xl, with a right-aligned button row whose primary sits rightmost at 8px gaps, offset space-12 from the top. Opening one closes any open popovers in code. Menus keep their existing tokens at 28px rows with 4px container padding; the disclosure chevron in trees is icon-sm and rotates instantly, and tree indent is 12px per level — the same quantum as the outline, so indentation reads as one vocabulary across chrome.

### Block handles on the writing surface

The manuscript needs block manipulation without becoming a block editor. The handle is icon-sm in control-fg and exists only on hover or block focus, in the left margin at the same 12px offset as the focus bar, and it never displaces text. It is a drag origin and a menu trigger. At rest the margin is empty — a persistent handle column is a block editor announcing itself.

### PDF annotation

Selecting text on the sheet summons a chrome popover at the selection end: menu-bg, radius-md, shadow-float, one 28px row carrying three 16px marker swatches at radius-xs plus Note, Quote and Copy. Swatches take a mandatory 1px border at 5.50:1 light and 4.39:1 dark, because the raw marker color computes to 1.59:1 against the menu surface. At rest a highlight is the only mark on the sheet: at-rest-is-print applies to sources with extra force, so the reader’s marks may appear — a reader marks printed pages — but the tool’s marks may not. Note anchors, comment counts, and author chips never render on the sheet; the annotation list is chrome. Hover deepens the wash to the paired -600 value, which is what those token pairs exist for, and a selected annotation takes the offset-outline focus mode. All washes over PDF content render in multiply.

### The style inspector

Built, at frontend/src/wcs/style/StyleInspector.tsx, and rendered by the writing pane and by a saved style’s own artifact pane from the same component. A pinned panel, not a modal, because it is read while the document changes underneath it. It carries five parts. The cascade breadcrumb names the scopes the current selection resolves through, outermost first, and is the only place the containment chain is visible. The saved-style slot names the applied style and, beside it, the count of values declared locally on top of it, with the two acts REQ-WCS-STYLE-SAVED requires — fold into the style, clear back to it. The origin column reports, per property, which scope the resolved value came from, since a value with no origin is indistinguishable from a default. The clear affordance follows the reveal contract, appearing on the row it belongs to rather than sitting in the panel at rest. And the disclosure tiers are the override contract’s common, more, and advanced, in that order, with the advanced advisory in muted type beside its control. Geometry is the modal and menu vocabulary: 28px rows, 13px/400 labels, radius-sm controls, no new tokens — checked rather than asserted, by grepping every custom property the ported stylesheet reads against tokens.css. One substitution was needed: a colour swatch is a native input that takes a hex and cannot take a var(), so its fallback is plain black rather than a ramp primitive the token layer forbids consuming.

### Style presentations

Built, at frontend/src/wcs/style/Floating.tsx, which owns the placement arithmetic; the writing pane raises all three from one piece of state, since they are one surface in three sizes rather than three surfaces. Three presentations chosen by how long the act lasts, not by which subsystem raises them, because placement is a system concern: a bar for an act that ends with the selection, a popover for an act that ends with a choice, and a pinned panel for an act that outlives both. The bar shares the PDF annotation popover’s geometry exactly — menu-bg, radius-md, shadow-float, one 28px row — and the two are specified together for that reason, since separately specified twins drift. The same three presentations and the placement rules under them govern the PDF annotation popover and the find bar as well, which is what makes this a system entry rather than a WCS one. Placement: at the selection’s end rather than its centre; flipped to the opposite side when the preferred side would clip; never covering the selection it acts on; one at a time, so opening one closes any other in code; and dismissed by the same paths as a menu. The bar covering the writing is real and was measured: a Playwright test that clicked a block’s centre while a selection was live began failing one run in two, because the browser correctly refuses to click through the bar. The bar is not at fault — the test now clicks the line the caret was going to anyway — but the overlap is a fact of the presentation rather than a hypothetical.

### Narrow panes and overflow

The writing page follows its clamp-and-collapse spec. Tabs overflow by horizontal scroll with no dropdown chevron and no shrinking below 96px, with a 16px mask fade at the clipped edge — a fade is a diagram of clipping, not a gradient decoration. Reference table columns collapse by declared priority — title, then year, authors, venue, then the rest — and title never collapses; the priority data belongs to REF, but the rule that a priority exists and that title survives belongs to the system. Panes never go below 240px, and the PDF sheet scales to fit width at any size rather than cropping.

### Cards

An issue card (stam's `IssueCard`, `web/src/itsa/IssueCard.tsx`) is drawn from the issue card layout in settings. Its slots run in order: TOP (the key, locked first, then up to three items, then the needs-you mark and the ⋯ menu, which can't be placed), TITLE (the locked title, clamped to one to three lines), META (up to five inline items, one row), BADGES (chips, one row, unlimited, clipped), and FOOT (up to three items, one row). An empty slot takes no height. Items keep their forms from the registry: `inline` text on TOP, META and FOOT, `chip` on BADGES.

Sizes: `board` is the kanban card, a `--surface-page` box with a `--border-subtle` hairline, `--radius-sm`, and its rows are as tall as their content, one line each. `nested`, inside a system-view agent card, has no box of its own, so no card sits in a card. Its first row is the status mark, the key and the title, on one line with an ellipsis, under a `--border-subtle` hairline; the rows after it are the issue layout's BADGES and FOOT, each `--space-4` tall, and the owner, which is the agent card's own, is left out. Its META is the board's, not drawn nested.

An agent card (`web/src/system/SystemCard.tsx`) is drawn from the agent card layout, with four slots in order: HEAD (its mark and name, fixed, then the items the layout places, by default its model and cost), ISSUE (the nested issue card, on or off), BADGES (the items the layout places in the order given: the Work badges health, review, tests and each field, which show when they have a value, and the agent's own items, such as context, mail and state, as chips), and FOOT (the items the layout places, by default its activity), with a context hairline along the foot. Its height is the default card's, 96 px, with its ISSUE row as tall as the nested rows the issue layout holds (`agentCardHeight`, `web/src/system/layout.ts`); it is worked out once per layout (in `SystemView`), not per card. ISSUE off makes the card one row shorter.

States: hover takes the `--border-default` border and shows the ⋯ menu; keyboard focus shows the focus ring; a dragged card dims to 50%; a drop target's column takes `--drop-fill`; needs-you is a warning badge in TOP; a closed ITSA's title is `--text-secondary`. Every state uses one channel.

Phone (360–430 px): the card is full width, the whole card is the target, and a long press opens its menu. Its ⋯ button is `--size-hit-touch` square.

The phone Work page's moving and ready-to-try rows (Glance, `web/src/work/Glance.tsx`) draw this same `board` card from the issue layout, so the phone follows Settings › Fields and cards › Issue card and shows what the board shows; `Field.card` no longer decides anything there. The card is read-only: no ⋯ button, no move hint, and a long press on a value opens the Work cell menu, not the move menu. Each item sits in a `data-cell` span for that menu. A link is an icon alone, as on the board, in a `--size-hit-touch` square (so a line with links is taller), and keeps the table chip's behaviour: a branch is only named, a tap on a PR opens its diff, and a long-press opens the cell menu, which names the link ("PR #15", the branch) because the phone has no hover, and offers View diff and Open on GitHub. The default layout shows the status, roll-up, links and owner; agents and cost show only if the layout places them. A layout saved in the editor redraws open cards.

In the editor the card is the same component, previewed at the board's column width; its states are the board's.

The Agent card tab (`web/src/system/AgentCardEditor.tsx`) edits the agent layout with the issue card's editor: a live preview of the real agent card for the agent picked (the first by default), the mark and the name locked in HEAD, ISSUE as a switch (the nested card's contents are the issue layout's), and the context hairline as a switch under the Available list. Its chips are the agent's items and the Work badges health, review, tests and fields; the issue item is the switch's. The desktop and phone editors are the shared `web/src/CardEditor.tsx` and `web/src/CardPhoneEditor.tsx`, over the model in `web/src/card-model.ts` (the issue's rules in `web/src/itsa/issue-layout.ts`, the agent's in `web/src/agent-layout.ts`).

### Fields and cards settings

Settings › Fields and cards (`web/src/views/WorkColumnsSettings.tsx`) has a segmented tab control (`.seg`): Fields, Table, Issue card and Agent card, addressable as `#cfg=fields/fields`, `#cfg=fields/table`, `#cfg=fields/issue` and `#cfg=fields/agent`. The Issue card and Agent card tabs are the card editors (below): the desktop one, or on a phone the touch one. On a phone the control spans the width and each button is `--size-hit-touch` tall; a field row is one such touch target, 44 px at least.

A field row shows its label and type, its key, and two muted lines: "Applies to" (All kinds, or the kinds it is limited to) and "Shown in" (Table and the issue card's slot, or Hidden). The form's Applies to is a checkbox per kind in use plus a kind typed in; the daemon's refusal of a save shows in `--status-error-fg` at the foot of the form, not as a toast. The form's "On the phone's card" control (chip or detail line) is read by the phone's Work card only. The issue and agent cards place a field in their own tabs, so a field's value shows wherever its layout places it. The setting also feeds the first load's seed of the issue and agent layouts.

The Issue card tab (`web/src/itsa/IssueCardEditor.tsx`, a desktop pane) has a live preview of one real ITSA (a sample when there are none), then a row per slot: TITLE with the locked title and its lines (1, 2 or 3), then TOP, META, BADGES and FOOT. Each item in a slot has a ⋯ to move it to another slot or hide it; a slot's + adds one from the Available list, which holds the hidden items with a search. The key and the title are locked, and the caps are TOP 3, META 5 and FOOT 3, enforced by the model and shown by a disabled +. A status line under the editor says each change (aria-live). Every change saves at once; Reset to default restores the seeded card. Its controls are desktop-sized; on a phone the tab is the touch editor (`web/src/itsa/IssueCardPhoneEditor.tsx`, S-1438 PR 7) instead. Its menus open under their trigger. Drag and keys (S-3314): a chip is dragged by pointer or touch from its slot or from Available. The ghost (`shadow-float`, `surface-raised`, `z-drag`) follows the pointer 1:1; the source chip stays in place at 50% opacity; the drop gap takes the chip's height in `drop-fill` with a `drop-border` dashed edge, and an Available list that would hide the chip takes `drop-fill`. The ghost keeps the grab offset, so the point the pointer grabbed stays under it. A drag selects no page text (`user-select: none` on the editor while it lasts). A refused move (locked, a slot at its cap, Links against a link kind) keeps the layout and hangs its reason under the slot it was for, in `status-error-fg` on `surface-raised`, over the rows below: it takes no room, so no row moves. Keys: Space lifts, the arrows step (within a slot, or to the slot above or below, skipping a slot at its cap, with Available as the slot after FOOT), Space drops, Escape cancels, Delete or Backspace hides. Leaving the editor cancels a key lift, and Escape cancels a pointer drag before its release. A key-lifted chip moves in the layout at once, raised on `shadow-raised` at full opacity with the focus ring, and no gap shows. A lift writes nothing; a drop writes once. Touch-dragged chips take `touch-action: none`, so a touch drag does not scroll the editor.

The phone editor (`web/src/itsa/IssueCardPhoneEditor.tsx`, 360-430 px, touch) keeps the same layout and rules as the desktop one, with its own shape: the preview is sticky at the top of the tab and scales to the width, then one list per slot (TOP, TITLE, META, BADGES, FOOT), each row `--size-hit-touch` tall. A row's controls are the handle ⠿, ↑, ↓ and ⋯, each `--size-hit-touch`; a locked row has a lock and none. ↑ and ↓ step within their slot first, and cross to the next slot only at its edge; the last Foot row's ↓ is disabled, since Hide is in the ⋯ sheet. A step the model refuses shows its reason under the slot it was for and writes nothing. ⋯ and + Add to card open the menu layer's bottom sheet: a choice the slot refuses is disabled and says why, and Add names the slot for each hidden item. A long press of the handle (`--duration-hold`) lifts the row; a drop writes once, a lift released in place or a cancelled press (travel before the hold, Escape, a touch cancel) writes nothing, and the list scrolls while a row is lifted, at the sticky preview's bottom edge (the top) and the window's bottom. The handle takes `touch-action: none`, so a scroll that starts on a row's text scrolls the list, and the drag never does.

## Empty, loading, and error

### Principle

One typographic stack serves empty, loading, and error on every surface: eyebrow, heading, body of at most 40ch, and at most one action. No icon by default. Loading is the same stack with a progress badge in the eyebrow position, and content appears when it is real. Error is the same stack with an error badge and one retry action, and the body states the failure factually.

### Surfaces

#### Per surface

| Token | Light | Dark | Use |
|---|---|---|---|
| `File tree` | Empty: "No files", action New file | Error: load failure stack with Retry | Standard stack both states |
| `Editor pane` | Empty: the shell placeholder stack, no illustration | Error: parse or load failure with Retry; the page surface does not render | A failed document must not present a blank page that could be mistaken for an empty one |
| `PDF pane` | Empty: stack, action Open PDF | Error: whole-document failure takes the stack; a single failed page keeps the sheet’s exact geometry with a centered chrome-type message and an error badge | The deck never reflows because one page failed, and no broken-image glyph ever appears |
| `Reference table` | Empty: stack, action Import .bib | Error: row-level failures badge in the status column; table-level failure takes the stack | Failure renders at its own granularity |
| `Find` | Empty: inline "No matches" in the find bar, text-muted | — | Never an overlay, never an empty-state stack for a search that simply missed |
| `Save failures` | Error badge in the pane’s context-line region | same | At the source, per the no-toast rule |

## Persona rules

- Cursors: text over text surfaces, pointer only on interactive chrome, grab and grabbing on handles and drags, col-resize on gutters, default elsewhere. The page never shows pointer at rest.
- No toasts. Status renders at its source: save state in the context line, row failures in their rows, badge changes in place. A floating notification stack is the single most software-scented surface a tool can grow. This reopens only if an error class with no on-screen source location ever exists, and then a single top-center transient bar gets specified rather than a stack. The local login offer is that bar's one persistent case (see "In mootr").
- No emoji, no illustration, no mascots anywhere. Empty states are typographic.
- No toggle switches, no boxed keycaps, no skeleton shimmer, no zebra striping on the page, no left-border blockquotes, no reference cards, no citation chips, no page icons or cover images.
- Microcopy register: sentence case everywhere; no exclamation marks; no first-person app voice — "Let’s get started" is banned; labels are scholarly nouns such as References, Manuscript, Figures, Annotations; empty states state a fact and offer one act; dialog buttons name their verb, so "Delete reference" rather than "OK".

## Print and export

### Principle

The export stylesheet consumes the document tokens with exactly three re-bindings, which is the whole point of having had a token layer: surface-page becomes pure white, because print is paper and the warm cast was a screen-fidelity choice rather than a print instruction; text-primary becomes pure black, because print is ink and "never pure black" is a screen rule; and all shadows become none.

### Notes

- Citation ink survives into PDF export. Publishers’ PDFs hyperlink in colored ink, and so does this one.
- The apparatus rules already cover paginated output: running heads at 0.8em small caps, folios in tabular figures, dot leaders only where page numbers exist.
- Everything beyond the token layer — Letter versus A4 and journal document classes — is template work by definition, because it varies per venue while the system does not. Page geometry itself is not: it is document-scope vocabulary, because the writing surface has to render the page the writer declared.

### Fidelity

**Requirement:** REQ-WCS-EXPORT-FIDELITY

#### Principle

Every property a writer can declare reaches every target under one of four stated policies, and the policy is part of the specification rather than something an exporter decides at the time. map — a native equivalent exists and the value is written to it. derive — the target computes it from its own geometry, so the value informs the export without appearing in it. emulate — reproducible, at a stated cost the export names. drop — meaningless there, and the export says so before it runs.

#### Policies

- map — LaTeX \setlength and package options, DOCX run and paragraph properties, CSS declarations. The value survives and round-trips.
- derive — chiefly measure and page geometry against LaTeX, where the class computes the text block from the page and the margins rather than accepting a column width directly.
- emulate — the cost is named per property and per target, and an emulation whose cost is not stated is not an emulation but a guess.
- drop — screen-only ergonomics against paper, and paper-only geometry against markdown. Dropping is legitimate and silent dropping is not.

#### Table location

The per-property table is carried by the property vocabulary itself — one exports entry per property, listing the target, the fidelity, and the mechanism — rather than being restated here. It is 56 properties against four targets, and a second copy in prose would drift from the one the exporter reads within a release. The vocabulary lives at project_site/src/prototypes/styleCascade/vocabulary.ts and is written to port into frontend/src/wcs/ unchanged. What belongs here is the contract above, which the table has to satisfy.

## Needs you list

The mailbox's Needs you toggle (S-3831) lists every ask waiting on you, oldest first, then the asks settled in the last day, dimmed, with their outcome in the age column. Its entry, "Needs you (N)", heads the mail rail above the Mail header and list: on the desktop, the Mail pane of the left sidebar; on the phone, the Inbox page's header, as a toggle beside Swipe and History, whose list takes the inbox list's place. The count is the open rows, and the header's count is the same number.

**Open ask link (S-3977).** A blocked agent shows "Open ask" when it waits on an open ask the human owes: a button in the warning colour, underlined, with the user mark. It is on the agent's row (the phone's Agents row, a sibling of the row's button at a 44 px touch target, the Agents table's Activity cell, and the desktop sidebar tree's row, S-3982; on the phone the tree's row is one tap target, so it hides there). It goes straight to the ask's card: a permission or mail ask to its home thread, an ITSA ask to its ITSA's page. The ITSA page shows it only for an ask its owner holds elsewhere, since the ITSA's own ask is the Waiting-on-you card below it. It is there only while that ask is open, so it goes when the ask settles, and it names the kind of ask, never the ask's text.

- **Tokens.** Rows are `.mrow` and use only `web/tokens.css` and `web/tokens-stam.css` (settled rows dim to `--text-muted`); the home and the agent are `--text-muted` one-line text, cut with an ellipsis. The row's gap is `--space-05`. Light and dark come from the same tokens.
- **Line one.** Kind, agent, home and age stay on one line: the agent, the home chip and the age or outcome each cut with an ellipsis, so a long name, home or outcome never pushes the line wider than the row. Each cut text keeps its full words in its title. The what sits on a second line only for an ITSA or a decision; a permission or a suggested input shows its kind alone.
- **Phone.** The Inbox page is one mode at a time: the inbox list, Needs you, or History, and each toggle replaces the other. While Needs you is pressed, the filter chips and the count line are hidden: the list is Needs you's alone, so no chip looks selected.
- **Touch.** On a phone each row is a touch target at `--size-hit-touch`, and a 360 px screen has no sideways scroll.
- **One answer rule.** A row never answers its ask. A tap opens the ITSA or the thread, and the ask card answers it there.
- **Text.** A permission row shows its kind only, never its action, details or text; the list never shows a secret.
- **Empty.** With nothing open and nothing settled, the list says so in one line, muted.

## Developer rules

- Calm at rest; instruments on approach. At rest a surface shows state and nothing else; controls materialize on hover or focus and vanish at 0ms. On the page the stricter form holds: nothing appears that would not appear on a printed page.
- Never let chrome type leak into the document, or serif into chrome. The document root sets the doc tokens and everything inside derives from them in em.
- Never put long-form prose directly on a pane surface, and never give the page a border. The page is distinguished by being lighter and carrying shadow-page, not by an outline.
- Each state owns one channel. Do not express dirty as a tint, lock as a wash, or selection as a ring — the composition rule depends on the channels staying separate.
- Elevation is lightness first, shadow second. Do not invent intermediate grays, and never add a neutral outside the ramps.
- Document tables rule horizontally only, and nothing on the page is ever zebra striped. Chrome tables keep their grid; that distinction is deliberate.
- Block quotations are set by indentation, never a left border bar. Reference lists use hanging indents, never bullets, cards, or boxes. Inline code on the page has no fill.
- Active tabs change color, not weight. The trailing slot renders exactly one glyph so tab width never jitters.
- Hover washes are translucent on purpose — rgba of the opposite pole, so they work on any surface without per-surface variants.
- Tabular figures are the shipped faces’ default, so alignment is safe unconditionally; declare tabular-nums anyway on tables, hints, and numbered apparatus, but never on document running text, where proportional figures are correct.
- Tree and table panes are full-bleed horizontally; hover and selection fills run edge-to-edge.
- Math is never scaled below 1em, and block math scrolls before it shrinks.
- All durations come from tokens. A hardcoded transition breaks prefers-reduced-motion, which is implemented solely by zeroing the three duration tokens.
- Set focus-halo-surface whenever a control sits on anything other than surface-app, or the halo gap renders in the wrong color and reads as a broken border.
- Over PDF content, every wash renders in multiply and the current-match ring is two-tone. On known grounds the single-tone rings apply.
- Sticky headers separate with a hairline, never a scroll shadow. The scrim animates opacity only — backdrop blur is the definition of glossy.
- At rest, the only accent anywhere in chrome is the focused pane’s tab underline. Persistent selection uses accent-subtle with primary text, never solid accent rows.
- Placeholder text uses text-muted, not text-disabled. Muted is AA; disabled is deliberately not.

## Completeness

### Covers

Identity and its two-jurisdiction first principle; the full color system with a computed AA audit and stated exemptions; two type scales with metrics measured from the binaries and a subsetting policy that makes OpenType feature survival a build property; the complete scholarly apparatus including lists, code, figures, links, and block selection; the eight-token override contract with its export round-trip semantics; spacing, density, radius, elevation, and motion with the reveal contract; focus geometry with the decided block marker; icons; the complete state vocabulary with its channel-composition rule and trailing-slot machine; buttons, inputs, tooltips, checkboxes, badges, modals, menus, trees, tables, and scrollbars; empty, loading, and error grammar per surface; multi-view differentiation; the PDF annotation interface with blend-mode guarantees over scans; narrow-pane and overflow behavior with a derived breakpoint; the print and export token layer; and the microcopy register.

### Out of scope

- Per-component pixel redlines — the exact padding of every composite widget, the reference table’s column widths, the find bar’s internal layout. These are derivations: each is constructible from the token, density, and state layers, and specifying them centrally would duplicate the source of truth the tokens are. The core owns the vocabulary; components own their sentences.
- Journal export templates — page geometry, Letter versus A4, per-venue document classes, citation styles. These vary per destination by nature. The core’s job is the token re-binding layer and the apparatus conventions they consume, and that is specified. A core that froze one journal’s geometry would be wrong for every other journal.
- The keyboard shortcut map and command set. That is interaction inventory, not visual system. The core specifies how shortcuts render wherever they appear — tabular hints, no keycap boxes.
- A data-visualization palette for user-generated charts. SS/DATA is shelved, and designing a palette for a subsystem that does not exist would be speculation. One constraint is recorded so the future system inherits it: status hues stay reserved and annotation hues stay on sources.
- Brand surfaces — app icon, marketing, the Project OS site itself. Different product, different audience, different rules.

### Line

The line falls where derivation begins. Everything a developer would otherwise have to decide is in the core; everything they can derive from the core belongs to components. That is what makes this complete — not that no work remains, but that nothing is left undecided.

## Sidebar defaults (S-3810)

Settings › Sidebar ends with a defaults row of three `.btn`s: **Save current as my default**, **Revert to my default** (disabled, with the title "No default saved yet", until one is saved) and **Revert to mootr's default** (3 panes of 2 tabs, compact strip). The live layout is `sidebarPanes` id `main`; the saved default is id `default` of the same record, which live edits never change. A revert replaces the whole live record and touches no other setting. On a phone the row's buttons are one column of `--size-hit-touch` targets (`.sbs-defaults`).
