# Design notes

Why the interface looks and behaves the way it does. Most of this is a record of
something that was tried, measured and changed; the reasoning is kept because
the conclusions are not obvious from the result.

[← back to the README](../README.md)

---

**The palette is deliberately colourless.** A near-neutral graphite in the dark
theme, a near-neutral paper in the light one, and no hue of their own beyond a
fraction of a degree of cool cast to stop large surfaces reading as dead grey.

That is the whole idea, and it follows from the material: glass has no colour;
what you see through it does. Every hue in the interface comes from the artwork
of whatever is playing. The wash over each pane, the ambient pools behind them,
and the accent on the primary controls are all the same sampled colour, so the
room takes on the colour of the record and nothing has to compete for it. A
fixed accent would have to fight the tint on every page, and one of them would
lose.

The only exception is the hi-res badge, which stays a fixed violet: it reports a
technical fact about the file, and that fact should not change colour with the
cover. It has a third state, for when the music server is converting rather than
sending the file: it loses both the lossless and the hi-res treatment for a
dashed edge, and names the codec and bitrate arriving instead of the depth and
rate on disk. It is the switch for that as well as the report of it, since the
place you notice the quality is the place you want to change it. There are no
glow effects and no saturated neon anywhere; depth comes from surface elevation,
hairline borders, and blur.

**The mark is a crest.** Heddohon is ヘッドホン (the Japanese word for headphones),
so it is built the way a *kamon* is: the subject drawn inside an enclosing ring
(the 丸に "within a circle" convention), strictly symmetric about the vertical,
made of solid forms separated by even negative space, and carrying no detail
that dies at 16px. The subject is what the name says: a headband arc concentric
with the ring, two solid earcups hanging from its ends.

The proportions are not free. The gap between the band and the ring is what
makes it read as a crest rather than as an icon that happens to sit in a circle;
close it and the interior becomes a solid mass, open it and the ring looks
unrelated to what it encloses. It was settled by rendering the alternatives side
by side at 64, 32 and 16px.

It lives in `Logo.svelte` and is used in the rail, on the sign-in panel, and as
the favicon, which is the same geometry inset to 72% of its tile. The favicon's
strokes are about 17% heavier relative to the form, because a 16px browser tab
needs it; note that `scale()` already thins strokes along with the geometry, so
correcting for the scale *and* bumping the weight closes the interior.

**Corners are evenly rounded**, on a scale where each step is roughly 1.35x the
last, so a button nested inside a card still reads as nested rather than
concentric; `22 / 16 / 12 / 9px`. The exceptions are the two actions beside the
now-playing title, favourite and add-to-playlist, which are full circles: the
only round things in the chrome, which is what separates them from the transport
row below without needing colour to do the job.

### Floating panels

Nothing in the chrome touches the window edge. The nav rail, the player panel
and the lyrics window are rounded slabs that sit *on* the page with a uniform
gutter around them, each carrying a hairline edge, an inner top highlight and a
soft drop shadow. The content column is the one thing that is not a panel
(framing it too would make every page read as a box inside a box), so it scrolls
freely behind the panels and the blur has real artwork to work with.

**Every page is centred in that column, and each page states its own maximum
width.** The centring is one rule in the layout rather than a declaration in
each page file, so a new route cannot forget it. The maximum is a reading
measure: a track row 2800px wide puts the title and the duration at opposite
ends of a 32:9 monitor, so the album, playlist, artist and settings pages hold
their measure and take margins instead. Library grids are the exception. They
already choose their own column count from the space they have, so capping them
only bit past 21:9, where it produced a band of dead space rather than more
records: they run to `--grid-max`, 2560px, which is a full row of 13 covers at
the default grid size.

Measured at 3440x1440 with the player panel open, where the content column is
2784px: the album grid went from 7 columns with 1288px of space on its right to
10 columns with 112px on each side, and the album page from a 1216px column
hard against the left edge to the same column with 784px on each side.

The sleeve is now a plain floating cover plate. An earlier version drew a vinyl
record protruding from behind it; that reads as an object on a shelf, but it
fought the floating-glass treatment (two conflicting depth metaphors on the same
element), and it cost a hover gutter on every hero. The cover alone is quieter
and survives at grid scale.

**The room changes colour from the moment you click.** The interface takes one
tint from the current artwork, applied at the document root. Resolving that
colour needs the cover decoded, and waiting for the page being opened to load
meant the room sat on the previous album's colour for 540ms after the click and
then swung over the next 900ms, which reads as a pause followed by a lurch. A
clicked card already has its cover on screen, so the click hands the colour
straight to the root and the change starts with the sleeve rather than after
it: measured at 111ms from click to first movement.

The rail and the player do not read the interpolated colour at all. Those two
are large, mostly one flat wash, and hold still while the page behind them
changes, so any unevenness in the interpolation shows up on them and nowhere
else, which is where it was reported. Each paints two static washes instead,
the colour it had and the colour it is going to, and only their opacity moves:
a cross-fade of two fixed layers asks the compositor for nothing per frame, no
gradient re-resolved and no backdrop re-blurred behind a value that is still
moving. They land on the same colour at the same time as everything else. At
rest the surface is within one part in 255 per channel of what it was before.

Two rules keep that honest. The offer is keyed to the destination, so a back
button, a rail link or an abandoned click cannot inherit it. And the tint
carries a generation number, so the colour that applies is the last one asked
for rather than the last one to resolve, which are not the same when one cover
is already decoded and another has to be fetched.

**Clicking a cover carries it into the album page, and going back carries it
home again.** The cover morphs between its grid position and the album hero
rather than the page cutting to a new layout; the View Transitions API doing the
work. Browsers without it, and anyone who has asked for reduced motion, get an
ordinary navigation to identical pages.

The cover is the only thing that animates. The page underneath used to
cross-fade, and the rail and the player carried names of their own so that they
would sit that cross-fade out: anything unnamed is captured inside the root
snapshot, whose old and new copies cross-fade, and cross-fading a bar with an
identical copy of itself shows the page straight through it.

Both names are gone, and with them the page cross-fade. A named element is
lifted out of the page and painted from a snapshot of itself for the length of
the transition, and those two are glass: their surface is a blur of what is
behind them, which a snapshot of the element alone does not have. On every
click in the rail a black rectangle the size of the rail appeared over it for
about half a second, square-cornered where the rail is round, and the page
dimmed with it. It was reported on iPadOS and then on Windows in every browser.
The old page is now dropped rather than faded and the new one shown at once,
which leaves nothing in the chrome painted from a snapshot of itself.
`::view-transition-new(root)` is the live page rather than a still of it, so
work arriving on the new page keeps moving while the cover travels.

Two details make the morph behave. A `view-transition-name` must be unique
within a document, and the home page happily shows the same release under two
shelves; a duplicated name makes the browser silently skip the transition for
*both*, so the name is claimed by the one cover that was actually clicked,
tracked by a per-card token rather than by album id alone. And the return leg is
armed from the departure: the album page records where it was opened from, so a
`popstate` back to that exact URL re-claims the same token on the grid card it
came from, while a back to anywhere else is an ordinary navigation.

### Editorial structure

Pages are laid out like a printed catalogue rather than a dashboard.

- **Sections are numbered and ruled.** A mono index sits in the margin, and a
  hairline runs from the title to the right edge. That single device is what makes
  a page of shelves read as an index instead of a stack of carousels.
- **The newest release is promoted out of the grid** and given the full width at
  poster scale, with its year set large and faint on the outer edge as a folio
  number. It is the page's only poster-scale moment; everything below is
  deliberately smaller.
- **Tracklists are printed indexes**: numbers hang in the margin, hairline rules
  separate entries, and hovering tints a row rather than filling it, so the eye
  reads down one column of titles instead of scanning a stack of buttons.
- **Long lists are paged at 100.** The artists page and each tab of favourites
  slice on the server and send only the visible page, so a library with thousands
  of artists renders as fast as one with twenty. Search on the artists page
  filters the whole library *before* the slice, so a name on page nine is still
  findable from page one.

### The artwork tint

**The colour is one field across the whole screen, not a property of each
panel.** It is painted once, full-bleed, behind everything: four overlapping
pools that fall off at different rates, so it reads as light with a direction to
it rather than as a coloured background. Nothing else paints it. The rail, the
player panel, the lyrics sheet and the featured release are all the same
translucent, blurred material, and what you see in them is that field showing
through, which is the difference between one light filling a room and a set of
separately tinted widgets that happen to agree.

That is also why there is exactly one place in the DOM carrying a colour: the
document root. `--art-h/s/l` are inherited registered properties, so the accent
on a button, the hover tint on a track row and the highlight on the current
lyric all resolve from the same value without any component setting its own. An
earlier version let the album hero and the featured release override the tint on
their own subtrees, which meant two or three different colours on screen at
once; that is what this replaced.

**The player is a column down the right-hand side, not a bar across the
bottom.** A strip 100px tall can give the artwork a 48px thumbnail and the title
a third of a screen to live in; a tall panel gives the cover the panel's full
width and stacks the metadata under it, which is the shape a now-playing view
wants.

The cover runs to the panel's own edges, takes every pixel of height the
controls do not want, and crops rather than fits, which is what makes it read as
scaled up: a square filling a box half again as tall as it is wide shows the
middle of itself, larger. There was a cap on that ratio for a while, to hold the
crop down, and it was wrong: it bought a band of bare panel between where the
artwork faded out and where the title began, so the fade stopped short of the
text instead of running into it, which is the entire point of the fade.

It dissolves into the controls through a mask on the artwork rather than a
gradient laid over it: a painted overlay would have to match the panel's
translucent ground, which changes with whatever cover is behind it, so it would
show as a band on some artwork and not others. Taking the artwork away instead
lets the real ground come through.

Two more things follow from the move and neither is cosmetic. It is open by
default, because a bar is always visible and replacing it with something that
hides would mean no play/pause on screen while you browse, so it docks as a real
grid column. And the queue lives inside it, swapped in where the artwork sits,
because both wanted the right edge and two slabs of glass fighting over it
looked like a bug.

**Closing it slides it off the edge rather than removing it.** The column it
occupies narrows from `--player-width` to `--player-sliver`, 22rem to 2rem, and
the panel keeps its own width, so the rest of it passes the right-hand edge of
the screen and is clipped there. Those are rem rather than pixels because the
interface scale is a root font-size: at the default they are 352px and 32px, and
at 150% they are half again as wide, which is the point. What stays behind is a
strip of the sliver plus the float gap, 44px at the default scale, carrying the
cover, the track title set down its length, and a chevron back. Pressing the strip reverses the same animation. An
earlier version unmounted the panel and moved the way back to the rail, which
put the control at the opposite corner from the thing it controlled.

One property drives that: `grid-template-columns` on the layout grid. The panel
sliding out and the content taking the space back are the same interpolation, so
there is no transform to keep in step with a reflow. It animates layout rather
than the compositor, and the cost is measurable: on the album grid with 69 cards
in a headless container, frames went from 13-20ms to 25-46ms for the 160ms the
slide lasts. The alternative is to snap the column and slide the panel over the
content with a transform, which costs one reflow rather than ten and makes the
whole library jump to a new column count in a single frame.

The panel body is faded out behind the strip rather than left showing through
it. Its first strip is a column of padding, a slice of the title and the left
edge of one tool button. `inert` moves with the fade in both directions, so the
hidden half is out of the tab order and out of the accessibility tree, and
pressing either control moves focus to the one that undoes it.

Where the window is too narrow for a rail and two columns, there is no
right-hand edge for a strip to sit on, and the panel becomes a sheet over the
content instead (which is what the design it is modelled on is on
a phone), and there it starts *closed*: arriving at your library with the player
covering it is not a player, it is a door. The server cannot know which of those
two it is rendering for, so it renders the column and the narrow layout keeps
the sheet hidden until the client has said how wide the screen is. Defaulting to
closed instead would reflow the whole grid on every desktop page load. Closed
means removed on that layout, and the rail carries the way back.

The colour is sampled in the browser. A 32x32 draw of the cover onto a canvas is
bucketed by hue, weighted toward saturated pixels at mid lightness, and averaged
as vectors rather than as raw degrees; otherwise the mean of 350° and 10° lands
at 180°, the exact opposite of the right answer. Artwork with no usable hue (a
grey or monochrome sleeve) falls back to a near-neutral rather than inventing a
colour, as does the idle state before anything has played.

Two things keep it from becoming a light show. Saturation is clamped to a 22–58%
band and lightness to 38–62% on the way out, so a garish sleeve tints the
interface rather than setting it on fire, and the tint is applied at 16–26% over
the surface colour, which is enough to notice and not enough to fight the text.
Hue changes ease over 900ms, taking the short way round the wheel.

This runs client-side rather than on the server on purpose: extracting it in
Node would mean shipping an image decoder like `sharp`, which is tens of
megabytes of native code for one decorative colour. The tradeoff is that the
tint arrives a frame or two after the server-rendered HTML, blooming in from
near-neutral.

The field's strength is one token per theme, `--ambience-strength`. It is worth
knowing how to check a change to it: the pools are radial, so reasoning about
the peak value tells you nothing useful about where text actually sits. Measure
the rendered pixels behind the text instead; hide the glyphs, screenshot the box
they occupied, and take the contrast against that. The two positions to watch
are the bottom of the rail and the top-right controls, which sit closest to two
of the pools.

**What sets the colour** is a short priority: whatever is actually playing wins,
because a colour that follows what you are hearing is doing something. Paused
does not count; a queue restored from the server means a track is loaded on
every page load, and letting that win would mean the room never responded to
where you are again. So a paused track yields to the subject of the page you are
on, and only takes the room back when the page has nothing of its own to offer.

Both themes ship, dark by default. The light theme is deliberately far less
transparent; a dark interface separates its layers by luminance and can afford
to be see-through, while a light one separates them by a few percent of grey,
and translucency eats exactly that difference. Theme choice is stored
server-side against your account, so the correct palette is in the
server-rendered HTML and there is no flash on load.

**Every piece of text carries a hairline of shade.** Type sits on translucent
panes over arbitrary artwork, and one pixel of shadow is what separates a glyph
from whatever the blur happens to be carrying. It is slight on purpose (enough
to hold an edge, not enough to read as an effect), and it flips with the theme:
a dark shadow under light type, a light halo under dark type, because a dark
shadow behind dark text on paper reads as ink bleeding. Text sitting on its own
solid fill opts out; there is nothing there to separate it from.

The shade is folded into the glow values rather than layered under them, because
`text-shadow` replaces rather than adds; a glow rule that forgot it would drop
the readability shade on exactly the text being looked at.

**Hover and selection light the text rather than plating it.** There is no grey
overlay anywhere in the interface: a row, a link or a control that is pointed at
or selected takes the room's colour and a two-layer bloom; a tight layer that
thickens the glyph, a wide one that spills into the surface, which is what
separates a glow from a blur. Icons take the same halo as a `drop-shadow`, since
a glyph cannot carry a `text-shadow`.

The light theme spends that idea differently, because it has to. Lighting text
means adding light and a pale ground has none to spare, so a halo behind dark
text reads as a printing fault rather than as illumination. There the label
takes the room's colour instead (as visible on paper as a glow is on a dark
ground), and the bloom is left as a whisper behind it.

`/healthz` reports a `build` identifier alongside its status. It answers the one
question that is otherwise guesswork behind a reverse proxy; did the thing you
just deployed actually replace the thing that was running? Curl it before and
after a deploy; if the value has not changed, the rebuild did not take, whatever
the log said.

**The lyrics take the artwork's place, the way the queue does.** They were a
floating sheet, which meant being positioned clear of the player's controls at
every width, and where the player is itself a sheet over the page, clear of
nothing: it covered the transport of the track whose words it was showing. In
the stage there is nothing to dodge. Three things went with the dialog and none
is missed: Escape and a close button (the tool row closes it), and the
expand/shrink toggle, because a fixed area has no small size and large size to
choose between. The stored `lyricsSize` preference went with that toggle.

They arrive and leave rather than cutting. The stage is a single grid cell with
its views stacked in it, so the words rise and fade in over the artwork and sink
back out as it returns, in place and without either one resizing. The queue does
not leave that way: holding it for an exit means holding a list that can be a
thousand rows long, so it fades in and goes at once. Opacity and a small
vertical travel are all that move; a blur or a scale reads well on a laptop and
costs a repaint of the whole stage per frame on a tablet.

**Controls are made of the same material, not of grey.** Buttons and sort chips
are translucent faces with their own small blur, so they sit in the light rather
than as slabs dropped onto it. The player panel goes the other way, and further
still when it is a sheet: a pane that covers the page has to stop the page
reading through it, because two layers of text on top of each other is noise
rather than depth.

**A dropped stream is picked back up, not reported.** Audio arrives over one
long-lived response, and plenty of things end one of those without the file
being at fault: a reverse proxy with a read timeout, an intermediary that caps
how long a single response may take, a connection pool briefly emptied by a page
full of cover art, a phone changing network. The player used to set `playing` to
false on the media element's `error` and put up "the stream stopped
unexpectedly", so any of those killed the music dead. It now re-requests the
same track and seeks back to where it stopped, four times with a widening
backoff, keeping the transport showing its loading state rather than a play
button, because this is a gap in the audio and not a stop. Measured against a
server that cuts the response and then refuses three reconnections: before, the
playhead froze at 20.2s and stayed there; after, it resumes within 0.2s of where
it dropped and plays on, and the listener never sees a message. A codec the
browser cannot decode is still reported immediately; asking again will not
change the answer.

Worth knowing what this does *not* fix: a browser's own silent retry already
handles a plain mid-body disconnect, so if you see playback stop, the stream is
being refused rather than merely interrupted, and the reason is upstream of
Heddohon.

**The artwork's colour is muted, not projected.** Three things were making it
shout. Saturation was allowed up to 58%, which on a saturated sleeve did not
tint the interface so much as take it over; it is held under 38% now, with the
floor still at 18% because below that every hue collapses into the same grey and
the effect stops being about the record. The per-panel tint is roughly halved.
And the panes' `backdrop-filter` was *boosting* saturation (160% on the standard
pane), which is a filter doing the opposite of what the material it imitates
does: a dark pane of glass mutes what is behind it. Every one of them now sits
below 100%, panes, controls and fields alike. The album art itself is untouched:
it is the subject, not the tint.

**The interface scales as a whole, and the setting is a ceiling.** A per-account
setting sizes everything at 100, 110, 125, 150 or 175 percent. It is the root
font-size, and every length in the interface is written against it: the spacing
steps, the rail and player widths, the corner radii and the icon sizes are all
rem. Borders stay at 1px, since a hairline is a hairline at any size. Album
cover minimums stay in px too, deliberately: a cover is a picture, and making it
half again as large does not make it more legible, it just fits fewer in the
row. Like the theme, the value is in the served HTML, so the page arrives at the
right size rather than resizing after hydration.

This was `zoom` first, on the grounds that it is what the browser's own zoom
control uses. It failed three separate ways, each found only after shipping:

- Media queries ignore it, so the layout kept believing it had the full width.
  At 150% on a 1440px viewport the content column had 304px, the hero ran under
  the player panel and the metadata line clipped mid-word.
- Viewport units ignore it, so `100dvh` was the whole viewport in CSS pixels and
  then painted half again taller. At 150% on a 1200px-tall viewport the app was
  1782px tall, and the player's transport and the rail's account controls were
  below the edge of the screen.
- Engines disagree about whether the initial containing block is divided by it
  to compensate. Chromium divides it, so an auto-width block lands on the
  viewport; WebKit does not, so the same page ran off the right-hand edge of an
  iPad by exactly the scale factor. This one was invisible in testing, because
  the only engine available to test in was the one that gets it right.

A font-size has none of them. Viewport units and the containing block are
untouched, and every engine treats it the same way.

The setting is still a ceiling rather than a fixed number. The rail and the
player are fixed rem columns, so they take a larger share of a fixed viewport as
the scale rises and the content column is what pays; each step applies only
while the screen is wide enough to leave that column its room. The default is
100 rather than something larger, so that the setting people get without asking
is the one that is known to be right everywhere.

**The rail is icons.** Six destinations, a crest above them and two account
controls below, in a 3.75rem column. The labels were 11rem of rail carrying
words for glyphs that already read, and that width now goes to the content and
the player instead.

The labels are still in the markup, clipped by `.hh-visually-hidden` rather than
removed. A removed label takes the accessible name with it, which would leave
the whole of the primary navigation as unnamed links; `title` gives a pointer
the same word on hover. The narrow bar this folds into on a phone had exactly
that bug, hiding its labels with `display: none`, and it is fixed by the same
change.

The crest lost its filled accent tile for the same glass the rest of the chrome
is made of: a solid block of colour was the one thing in the interface not made
of that material, and it was the first thing the eye hit on every page. A
hairline under it says where identity ends and navigation begins.

**No scrollbars.** Every scrolling region sits inside a floating panel, where a
rail down the edge crosses the pane's rounded corner and reads as a seam rather
than as a control. The trade is worth naming, because it is not free: a
scrollbar is also the only signal that a region scrolls at all, and the only way
to scroll one with a pointer alone. So the library, the queue and the lyrics
each carry a tab stop now; WCAG 2.1.1 does not allow a scrollable region to be
unreachable from the keyboard, and with nothing to drag, the keyboard is what is
left. Chrome makes overflow containers focusable by itself; Safari does not,
which is why this is declared rather than assumed.

Glass degrades in two directions. Browsers without `backdrop-filter` get opaque
surfaces via `@supports`, and anyone who has asked their system for
`prefers-reduced-transparency: reduce` gets opaque surfaces and no ambient wash
at all. `prefers-reduced-motion` additionally stops the tint from animating.
Those overrides have to sit *after* the rules they undo; they are single-class
selectors, so source order is the only thing separating them, and putting the
control fallbacks up with the pane primitives left the buttons translucent for
exactly the people who asked for them not to be.

### Making a derived accent legible

Deriving the accent from the artwork means it has to stay readable for *every*
hue a cover can produce, which is a harder constraint than picking one colour
and checking it once. Two measurements shaped the values in `app.css`, and both
are worth knowing before changing them.

**HSL lightness is not perceptual.** Yellow at 70% lightness is far brighter
than blue at 70%. So the accent's lightness and its saturation ceiling were
solved by sweeping all 360 hues against every surface it can land on (as a label
on itself and as accent-coloured text), and taking the worst case. Dark lands at
70% lightness with saturation capped at 52%, holding 4.5:1; light has to go much
darker, to 27%, because white is a harder ground to sit on than near-black.
Raising either value breaks the contrast floor.

**A muted grey cannot survive on glass unaided.** A muted tone is *defined* by
sitting close to its own surface, so on a translucent pane the thing behind the
pane decides its contrast, and a white cover inverts the relationship entirely.
Measured: over a white cover, muted text on the dark pane never reaches 4.5:1 at
any opacity up to 86%, because raising the opacity only moves the composite back
toward the surface the grey was already close to. Opacity is not the lever.

Three things fix it together. The pane stays genuinely see-through at 52%; the
backdrop is attenuated by a `brightness()` inside the blur, which is what
frosted glass does to light passing through it anyway, and the secondary tones
are replaced on anything translucent (`--text-muted-through` and
`--text-faint-through`, lifted in the dark theme and deepened in the light one)
far enough from the composite to clear 4.5:1 and 3:1 against the worst backdrop
a cover can produce. They still read as secondary against the pane, which is all
they were ever for.

This applies to every see-through surface, not just the panes. A sort chip label
measured 4.53:1 against a 4.5 floor on its first translucent outing, for exactly
this reason; on the through-glass tone it is 6.8:1, with a worst case of 7.1
swept across the hues a cover can produce.

Type is two faces doing three jobs: **Manrope** for both display and interface,
and **JetBrains Mono** with tabular figures for anything numeric (durations,
bitrates, track numbers), so columns line up and the clock does not jitter as it
ticks. Both are self-hosted; nothing is fetched from a CDN at runtime.

Display and interface sharing a family is the point. The separation comes from
the *cut* rather than from a second typeface: headings run at weight 800 with
`-0.035em` tracking, which on a variable grotesk closes the counters into a
solid mass, while body text sits at normal weight and tracking. A page then has
one voice at two volumes, which is what keeps a glass interface from looking
busy; a high-contrast Didone against glass fights the blur, because hairline
serifs are the first thing a backdrop filter smears.

Exactly two lines pick the faces (`--font-display` and `--font-ui` in
`src/lib/styles/app.css`), and nothing else names a family. Point them at the
same value for the single-voice treatment above, or split them for contrast:
**Newsreader** or **Fraunces** for display against Manrope for the interface
both work, and both want `--display-weight` dropped toward 600 and
`--display-tracking` toward `-0.01em`. Install the matching
`@fontsource-variable/…` package and change the `@import` alongside the
variable.
