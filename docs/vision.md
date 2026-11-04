# Cartochron: an investigation workbench

> Adapters collect. Cartochron preserves observations. Investigators reason.

Cartochron should not compete by collecting the largest number of location feeds.
Its purpose is to help people ask precise questions of incomplete, differently
sourced observations over space and time—and to see the limits of the answers.
This document preserves the long-term direction; it is **not** a v0.1 feature
list or a claim that the capabilities below already exist.

## The central distinction: observation is not truth

A dot is a reported position. A line is a visualization of selected recorded
positions. Neither proves where a device, much less a person, was continuously
present. An intersection of routes is not evidence of a meeting. A missing
observation is not proof of absence. A label is an operator assertion, not an
authenticated identity.

The core vocabulary stays explicit:

- **Source:** an operator-enrolled, descriptive identity, distinct from proof
  of physical ownership.
- **Channel:** a stable configured input, for example a GPSD UDP listener or a
  Metasploit acquisition configuration. Channels can change their human label
  without changing recorded provenance.
- **Run:** one acquisition/recording session. Reconnecting or starting a new
  process must not silently join separate recorded journeys.
- **Observation:** accepted coordinates, the server's receipt clock, and
  optional producer-reported measurement time, accuracy, and provider.
- **Artifact (future):** imported source material, with origin, acquisition,
  integrity and retention information. A hash establishes integrity of bytes,
  not truth of the assertions inside.
- **Reported event (future):** a source's claim that something occurred at a
  time and place, with explicit provenance and uncertainty.
- **Annotation (future):** the investigator's interpretation or note, never
  silently promoted into an observation or verified event.

These are different kinds of claims. We should never force them all into the
position-observation table or infer identities from names, IP addresses,
coincidental locations, or matching track prefixes.

## The investigation loop

A useful analysis tool supports a disciplined feedback loop:

1. **Define a question.** Which source reported something? At what time?
   What is the claimed location? Which observation interval matters?
2. **Inspect what is actually recorded.** Preserve acquisition channel,
   receiver time, optional measurement time, confidence limitations, and
   incomplete pages. Keep independent runs independent.
3. **Form a hypothesis.** State the expected invariant and a plausible benign
   explanation. A graphical pattern is not, by itself, a conclusion.
4. **Seek the cheapest falsification.** Compare sources, examine gaps,
   consider clock offsets and measurement accuracy, inspect original artifacts.
5. **Record the result and its limits.** Distinguish observed evidence,
   inference, alternative explanations, and unknown intervals. Do not hide
   contradictory observations or make a report sound more certain than it is.

That feedback loop is the **cybernetic** part of Cartochron: observable state,
explicit uncertainty, and corrections grounded in new evidence—not automatic
stories invented between data points.

## What belongs in the core

Cartochron's core is the common language for observation storage and analysis:

- Provenance: source, channel, run, observation, receipt/measurement clocks.
- Monitor: latest reported position and receipt freshness for known channels,
  without pretending that a feed is connected or the position is current.
- History: inspect each recorded run and browse old intervals without losing
  evidence or connecting separate runs.
- Gaps and discontinuities: visibly distinguish recorded intervals from
  unobserved time and possible positioning jumps.
- Compare tracks and shared time: inspect spatial overlap **and** temporal
  overlap; neither means that physical actors met.
- Inspect a place: expose which *loaded* observations fall near a location
  and state the coverage and accuracy limitations.
- Future analysis primitives: saved queries, repeat visits, dwell intervals,
  route comparison, co-presence hypotheses, event overlays, investigator
  annotations, evidence-linked reports and case workspaces.

The future primitives must preserve their assumptions. A dwell interval, for
example, requires a stated rule about maximum observation gaps, accuracy and
minimum supporting observations. It should be a *derived* interpretation with
provenance, never a fabricated raw fact.

## Outside the core: three kinds of integration

The term *plugin* should describe a stable boundary, not require in-process
code execution or a complicated plugin runtime.

1. **Observation producers.** Metasploit, GPSD, later GPX/KML/KMZ importers
   and a separately designed consent-based mobile client. They map external
   measurements into the observation API, preserving producer-specific limits.
2. **Reported-event producers.** Future incident, road-closure, restriction,
   sighting or other authorized event feeds. Their event model, time bases,
   attribution and permissions differ from position observations.
3. **Context/overlay providers.** Future zones, routes, polygons, road
   restrictions and other contextual layers. An overlay is not a recorded
   observation about a device and may expire or be corrected independently.

Adapters can live in separate repositories and processes. An outage, parser
bug, or incompatible upstream format should not corrupt the receiver's
existing observations. Prefer small HTTP contracts to shared framework
packages, database coupling, or remote plugins executing inside Cartochron.

External feeds require careful licensing, authenticity, freshness, security
and privacy handling. A real-time accident or restricted-zone overlay should
carry the feed's own observation time, update time, validity window and
provenance. An expired restriction should never look active solely because
Cartochron still has its last record.

## Product behavior matters as much as data structures

- **Operator-first navigation:** Monitor follows a stable configured channel
  or enrolled source; History browses individual runs.
- **Camera agency:** Free mode never fights user panning; Follow selected and
  Follow visible are explicit; far-apart sources do not make the viewport
  bounce between cities.
- **Nothing silently rewritten:** new labels or retrospective annotations must
  not mutate the source/channel assertions attached to old runs.
- **Bounded truth claims:** state when a result covers only loaded pages,
  recent fixes, or a subset of sources. Avoid invisible truncation.
- **Readable evidence:** exact identifiers, timestamps, source claims,
  alternatives and coverage should be available behind approachable labels.
- **Manual as an instrument:** explain what the control does, what it does
  *not* establish, and how to reproduce an analysis with synthetic examples.

## A handbook, not just setup instructions

The long-term handbook should teach seven complementary skills:

1. The mental model: source, channel, run, observation, reported event,
   annotation, and the difference between receipt and measurement time.
2. Deployment and first controlled experiment: local receiver, safe
   authentication, backup/restore, synthetic observations.
3. Acquisition examples: GPSD and Metasploit as separate adapters, with
   their distinct fidelity and uncertainty; future imports only when built.
4. Map operation: Monitor/History, camera, position inspection, gaps,
   discontinuities, comparisons and completeness limits.
5. Investigation workflows: test a temporal overlap, repeated presence or
   apparent route intersection with explicit alternative explanations.
6. Evidence/provenance practice: how to document a finding without turning
   a guess into an observation.
7. Illustrated case studies: multiple runs for one source; two sources at one
   coordinate; two cities; a stale position; a gap; a route crossing in
   different time windows; a place search with incomplete pages.

Every image should use **synthetic, reproducible data**, annotated to explain
what is visible and what remains unknown. Actual private location data does
not belong in the repository. The initial [handbook](handbook.md) links to the
working `/help` manual and existing synthetic illustrations.

## Release discipline

For **v0.1**, stabilize the existing observation system, UX, tests,
operations, documentation, and release reproducibility. The first release
need not ship annotation engines, incident feeds, spatial databases,
case management or a generalized plugin SDK.

Later work should be justified by a clear question an investigator cannot yet
answer, an invariant to preserve, a bounded data contract, and a reproducible
test. Implement the smallest mechanism that answers the question. Avoid adding
new machinery simply because more data sources *might* exist.

### North star

Cartochron is not another phone tracker. It is an **analysis workbench for
incomplete, provenance-aware observations across space and time**. Its value
is in making the boundary between *seen*, *reported*, *inferred* and
*unknown* legible enough that an investigator can reason responsibly.
