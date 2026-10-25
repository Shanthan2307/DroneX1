# DroneX × the four technologies

**DroneX in one line:** design a drone from real parts, let physics say whether it flies, talk to it, then fly it
over a real San Francisco with other people's drones in the same sky. Four technologies each own a piece of that
sentence. Take any one away and the sentence gets shorter.

Every claim below runs live from `http://localhost:3000/scenarios` and every number comes from a logged run.

---

## SpacetimeDB: the sky is a database

**The problem it solves.** Two operators, one sky. "Check whether the corridor is free, then take it" is a race
condition with aircraft in it. A web server in the middle adds a hop, a cache and a lie: by the time the client
hears "free", it may not be.

**What DroneX does with it.** The airspace *is* the database. Vehicles, positions, corridors, incidents and
mission assignments are tables (`DroneX_live/spacetime/src/lib.rs`, 349 lines). The separation rule is a reducer
beside the corridor table: 10 m lateral, 10 m vertical, a time-to-live. A request is granted or refused inside the
transaction, and every subscriber (the airspace map, the Fetch.ai agents, the mirror) sees the same row in the
same frame. A scheduled reducer expires stale corridors and marks silent vehicles offline, with no cron job.

**The moment to watch.** Scenario *Two operators, one sky*: a UCSF courier holds 75–95 m over Mission Bay. A survey
hexacopter asks to cross in the same band. The reducer answers:

> REFUSED: conflicts with corridor 17 held by Bravo (0 m apart, 75–95 m band); climb above 105 m or wait for it
> to expire

It re-asks at 110–130 m, is granted, and both drones fly their missions. The refusal flashes on the airspace map
with the reducer's own words.

**Without it** the airspace would be an API server guarding a Postgres table with a lock. Slower, a second code
path to get wrong, and no live map for free.

---

## Elastic: the flight data exhaust, finally in one place

**The problem it solves.** A drone program makes three silos nobody joins: what the designer predicted, what the
aircraft did, and what the autopilot's 5,799-parameter manual says to change. Post-flight analysis is a human with
three browser tabs.

**What DroneX does with it.** One cluster, nine indices. The mirror streams every fix and event
(`dronex-telemetry`, 10,000+ fixes; `dronex-events`); the configurator writes every verdict (`dronex-verdicts`);
the ArduCopter manual, the parts' datasheet notes and the physics formulas sit in `semantic_text`
(`dronex-ardupilot-params`, 5,799 docs). ES|QL joins prediction to flight; semantic search answers in plain
language; an Agent Builder agent and a Workflow score flights as they end.

**The moment to watch.** Scenario *After the flight, find the signal*. The courier flies Mission Bay → Pier 40.
Then, in one breath:

- ES|QL over 311 armed fixes: battery 100 % → 68 %, 11.5 %/min, which projects **8.7 min** from full to empty.
- ES|QL over the verdicts: the configurator's mixed-flying estimate for that design was **8.8 min**. The physics
  was right to within 0.1 minute, and Elastic is where you can see that.
- Semantic search: "low battery failsafe action" → `BATT_FS_LOW_ACT`. "¿qué altura usa el dron para volver a
  casa?" → `RTL_ALT_M`. No keywords, no English required.

**We measured the embeddings, we did not guess.** 21 real questions against the manual, six setups
(`DroneX_live/scripts/eval-embeddings.ts`): Jina v5 text-small through the Elastic Inference Service finds the
right parameter in the top three 62 % of the time; ELSER 24 %; keyword search 14 %. The only setup that handles
other languages and questions worded unlike the docs. It is the default.

**Without it** every number in that scenario is a log file and a spreadsheet, and "what should I set" is a forum
search.

---

## Cartesia: the voice of a product whose users have their hands full

**The problem it solves.** A pilot's hands are on the sticks and their eyes are on the aircraft. A builder is
turning a part over in 3D. A screen is the wrong interface at exactly the moment they need an answer. Voice only
works there if it is fast enough to feel like a person and interruptible like one.

**What DroneX does with it.** Two voices, one stack. **Ask DroneX** on the configurator: hold to talk (Ink,
`ink-2`, streaming, with the parts vocabulary as key terms), the answer spoken back (Sonic, `sonic-3.6`),
explaining what a part does, why a mission fails, which swap passes, then a button that makes the swap. The
**flight copilot** on `/copilot`: spoken commands become ArduPilot actions, and 17 kinds of deterministic callouts
(arming, altitude bands, GPS, EKF, battery, mission legs, building ahead) are spoken as telemetry changes, with
barge-in so a warning cuts across a status line. The API key never leaves the server; the browser gets a
ten-minute token.

**The moment to watch.** Scenario *Hands on the sticks*: a waterfront patrol flown entirely by voice. "Take off to
thirty metres" is real Sonic audio, Ink hears "Take off to 30 meters", the copilot arms and climbs, and the
callouts land as they happen: *motors armed, airborne, passing ten metres, mission leg two*. 24 speech calls in
one two-minute run, zero errors. On the configurator: "Why does this fail the sprint?" is answered with the
physics numbers and a spoken offer of the motor that fixes it.

**Without it** DroneX is a very good form. With it, it is a colleague who knows every datasheet and is watching
your aircraft.

---

## Fetch.ai: a sentence becomes a flight

**The problem it solves.** Agent demos are usually a chatbot describing work it did not do. A clinic does not want
a conversation; it wants a drone that can carry the sample, verified, in the air.

**What DroneX does with it.** **DroneX Dispatch**: ten uAgents (`DroneX_agents/`). A dispatcher on Agentverse with
a mailbox, discoverable in ASI:One, speaking the Agent Chat Protocol with Interactive Cards (form → carousel →
review → detail). Eight fleet agents, one per hangar drone, each answering from its own physics verdict. A flight
agent that owns the simulator: waits for GPS and EKF, takes off, reserves a SpacetimeDB corridor, flies to the
place, reports back. Agent Payment Protocol as the bonus: the dispatcher pays 0.5 testnet FET on Dorado and the
flight agent **verifies the transaction on chain before take-off**
(`DB3BC0F10F3FEAD70DFF86EEE4C5A2FCCDCBFC830EB5F75FDCEBD69F654C3321`).

**The moment to watch.** Scenario *A clinic asks, the fleet answers*: "a 160 km/h sprint over 2 km to Coit Tower,
back in 5 minutes" goes in through the Agentverse mailbox. The fleet answers; one drone passes; the review card
shows lift, weight, endurance from `dronePhysics.js`; approve; and the log reads *GPS fix and EKF good → arming →
airborne at 17 m → corridor to Coit Tower reserved (#20, 30–50 m) → go to 37.79095, -122.40544: accepted*. When
nothing passes, the dispatcher says which check failed and searches for a one-part swap, judged by the same
physics, before offering it.

**Honest footnote.** The agent is listed, named and answering through its mailbox; messages sent the way ASI:One
sends them arrive. ASI:One's own API had not yet routed a chat to it at the last test; `scripts/asi1_e2e.py`
decides pass/fail from the dispatcher's log, never from the model's words, because the model will happily describe
a reply it never received.

**Without it** the front door to DroneX is a web page. With it, the front door is any sentence, anywhere ASI:One
is.

---

## The rule all four obey

**Code decides; models explain.** Whether a drone flies is computed by `dronePhysics.js` from sourced part
records. Cartesia speaks those numbers, Elastic stores and finds them, the Fetch.ai agents carry them, SpacetimeDB
enforces the sky around them. None of the four invents a number. That is why each one is load-bearing: they are
not decoration on a model's opinion, they are the plumbing of a verdict.
