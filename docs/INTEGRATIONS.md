# Technology integrations under consideration

One section per technology we have looked at for DroneX: what it is, whether it genuinely helps, what it would
change, what it would make possible, what it needs, and the decision. Nothing here is built unless its status says
so. Review this file to decide which to take on.

| Technology | Role it would play | Fit | Status | Assessed |
|---|---|---|---|---|
| [Fetch.ai / ASI:One](#fetchai--asione-dronex-dispatch) | User-facing agent layer: a sentence in ASI:One becomes a verified, flying vehicle | Strong | Chosen, building (2026-10-25) | 2026-10-24 |
| [Creao AI](#creao-ai-back-office-agents) | Back-office automation: sourcing, datasheets, reports, procurement | Good for the periphery, wrong for the core | Assessed, undecided | 2026-10-24 |
| [CRS Credit API](#crs-credit-api-finance-the-build) | Financing, business credit and compliance screening at the end of the design flow | Weak for the core, plausible as the last step | Assessed, undecided | 2026-10-24 |
| [Cartesia](#cartesia-voice-copilot-for-the-simulator) | Voice copilot in the simulator: spoken commands in, callouts and warnings out | Strong for the simulation engine, weak for the configurator | Chosen, building (2026-10-25) | 2026-10-24 |
| [Bitdeer AI Model Studio](#bitdeer-ai-model-studio-the-brain-behind-the-assistant) | Hosted open-weight LLM inference (OpenAI-compatible) as the model behind the simulator assistant and a design advisor | Neutral: a provider swap, not a capability | Assessed, undecided | 2026-10-24 |
| [Moss](#moss-sub-10-ms-retrieval-inside-the-app) | In-process semantic search over the catalog, hangar, places and assistant tools; the retrieval layer under a voice copilot | Useful but small alone; strong paired with Cartesia | Assessed, undecided | 2026-10-24 |
| [SpaceXAI (Grok)](#spacexai-make-it-legendary-real-space-data-grok-cursor) | Real space data into the simulator (GNSS satellite visibility over the city, satellite terrain) plus Grok Voice or Imagine; built in Cursor | Moderate: one strong idea, two process rules | Assessed, undecided | 2026-10-24 |
| [Convex](#convex-one-live-typescript-backend-for-the-configurator) | Live TypeScript backend: shared hangar, cross-machine designs and models, durable Fly workflow, mirrored live telemetry | Good for sharing and multi-user; a platform choice otherwise | Assessed, undecided | 2026-10-24 |
| [Microsoft: Built for the Real World + Customer Impact](#microsoft-built-for-the-real-world-and-customer-impact-award) | A framing track: production-minded agent, measurable usefulness, responsible design | Good if the Dispatch agent is built; no technology to add | Assessed, undecided | 2026-10-24 |
| [Apify + Best Actor](#apify-a-datasheet-and-thrust-table-actor-for-the-catalog) | A published Actor that turns manufacturer and retailer pages into sourced catalog records and measured thrust tables | Good and honest, but offline tooling, not the live loop | Assessed, undecided | 2026-10-24 |
| [Elastic](#elastic-search-and-analytics-over-the-flight-data-exhaust) | Elastic Cloud Serverless over flight telemetry, ArduPilot docs and catalog notes; an agent and a workflow that find the signal across flights | Good and distinct: the only track about the data the product already produces | Chosen, built 2026-10-25 (live indexing needs the cluster) | 2026-10-24 |
| [Bright Data](#bright-data-unlock-find-and-fetch-the-datasheets) | Scraping infrastructure (Unlocker, SERP, Scraper APIs, hosted MCP) for the datasheet and price pipeline and for live lookups by the agents | Good for the catalog pipeline; same slot as Apify, pick one | Assessed, undecided | 2026-10-24 |
| [Mana.space](#manaspace-a-build-tool-track) | A build-tool and distribution track: Mana plans, writes or debugs part of the work; bonus if a DroneX app or agent lives inside Mana | Neutral: process, not product; could not verify the product online | Assessed, undecided | 2026-10-24 |
| [SpacetimeDB](#spacetimedb-a-shared-persistent-airspace) | Shared persistent airspace: every operator's vehicles, missions, corridors and agents in one live world with rules enforced next to the data | Strong and the title sponsor; same slot as Convex, pick one | Chosen, building (2026-10-25) | 2026-10-24 |

---

## Fetch.ai / ASI:One: DroneX Dispatch

**Challenge:** ASI:One Agent Challenge, "From Intent to Action". Mandatory: an agent registered on Agentverse,
implementing the Agent Chat Protocol (ACP), discoverable and usable through ASI:One, with meaningful tool execution
or multi-agent orchestration, and the whole primary workflow inside an ASI:One conversation. Bonus: multi-agent
collaboration, Payment Protocol, Interactive Cards, reliability, real-time data, an agent that keeps running.

**What it is.** uAgents (Python) with a mailbox so the agents run on the laptop next to the simulation engine's
unix socket yet are reachable from ASI:One. Interactive Cards (form, carousel, review, detail) are declared in a
`MetadataContent` block of a chat message (`card_protocol_version` "1", `requires_card_interaction` "true",
`card_kind`, `card_payload` as a JSON string under 64 KB). Card answers come back as text, either JSON or planner
prose, so both must be parsed.

**Does it genuinely help?** Yes. It adds the missing front door: a clinic or farm asks for a job done, not a drone.
Every step is a tool call into code that exists (catalog, physics verdict, mission matrix, `sim/start`,
`param/set`, `plan/route`, `plan/upload`, `command/send`, `telemetry/get`). It does not touch the physics or the
simulator's correctness.

**What we would build: a third engine, `DroneX_agents/`.**

| Agent | Role | Tools |
|---|---|---|
| Dispatcher | Entry point on ASI:One; parses intent with the ASI:One model, orchestrates, renders cards | ASI:One LLM for intent only |
| Fleet agents (one per hangar drone, 8) | Answer capability queries from their physics verdict | Verdict, mission matrix via one new HTTP route in the configurator |
| Flight agent | Owns the simulation engine | Core RPC over the unix socket, the existing fly pipeline |

Demo conversation: user asks to deliver 2 kg of blood samples 6 km in 20 minutes → form card for missing facts →
carousel of candidate drones with pass/fail badges and reasons → review card with all-up weight, endurance, range
and discharge margins, Approve/Reject → on approve the flight agent packs the design, starts the vehicle, writes
the battery and hover parameters, routes around buildings, uploads the mission, arms, takes off, streams progress,
ends with a detail card holding telemetry and the 3D map link → if nothing qualifies, names the failing part and
offers the swap, opening that build in the configurator. Hero: medical courier + delivery mission.

Bonus: Payment Protocol, a fleet agent quotes a per-flight simulation price (testnet FET) and the dispatcher
commits before launch. About half a day extra.

**Making it look intended from the start.** Own folder with README, `pyproject.toml` and `dev.sh`; a `/dispatch`
page in the configurator (the three engines, live agent addresses, Agentverse status, "Chat in ASI:One"); a third
row in the root README's engine table; SPEC, ARCHITECTURE and ROADMAP gain the agent layer; several commits.

**Needs from the user.** ASI:One API key in an env file (never pasted in chat); Agentverse clicks (inspector →
Connect → Mailbox, then name, handle, README on the dashboard); confirm the hero drone; decide on payments; the
agents run on the laptop during judging. Setup we do: Python 3.11 via Homebrew (the machine has 3.9, unsupported
by uAgents) and the `uagents` package.

**Risks.** Card responses may arrive as prose, not JSON. Discovery needs the agents online with their manifest
published before judging, like `dev.sh`.

**Decision:** chosen on 2026-10-25; built in `DroneX_agents/`.

**Tested (2026-10-25).** With the mailbox off, a sentence goes through intent (ASI:One model), the carousel and
review cards, approval, the stored design started in SITL, the wait for GPS and EKF, takeoff, a corridor granted
by the SpacetimeDB reducer and the go-to; the Payment Protocol paid 0.5 testnet FET on Dorado and the flight agent
checked the transaction on chain before flying. With the mailbox on, the dispatcher registers in the Almanac as a
mailbox agent; Agentverse creates the mailbox only with the owner's key (`scripts/connect_agentverse.py`, or the
inspector's Connect button), and `scripts/asi1_e2e.py` then tests ASI:One end to end. Found while testing: before
the mailbox existed, the ASI:One agentic model answered *as if* it had reached the agent, so that script decides
pass or fail from the dispatcher's own log, never from the model's words. Also found: the default `cosmpy` testnet
config speaks gRPC, which this network blocks; the agents use Dorado's REST endpoint.

Docs: uagents.fetch.ai/docs/examples/asi-1 · docs.agentverse.ai/documentation/advanced-usages/agent-driven-interactive-cards ·
docs.agentverse.ai/documentation/advanced-usages/predefined-card-schemas · uagents.fetch.ai/docs/guides/agent-payment-protocol ·
fetch.ai/docs/examples/agentverse/mailbox-agents

---

## Creao AI: back-office agents

**Challenge tracks** (one rule for all: a CREAO agent does the core work): 01 Best AI-First Disruptor, $2,500,
"remove the agent and the product stops working", built with API Trigger + webhooks, connectors, Browser Use;
02 Best One-Person Company, $1,500, an org chart of agents handing work to each other, one saved agent per role,
coordinated by a scheduled workflow or an orchestrator via API Trigger; 03 Best Team Empowerment, $1,000, agents
as connective tissue between people, Slack/Teams/Notion connectors, scheduled runs, webhook handoffs.

**What it is.** A no-code platform for recurring business automation: describe a job, it builds an agent that
runs on a schedule or trigger, with OAuth connectors (Gmail, Sheets, Slack, GitHub, Notion, 100+), Browser Use
(logs into sites, fills forms, scrapes), persistent memory, approval gating on write actions, and file outputs
(PDF, images, audio, video). External apps call it through an asynchronous API Trigger
(`POST https://agent.creao.ai/api/v1/apps/{appId}/runs` with `inputs`, a `capi_` key, then poll or receive a
`webhookUrl` POST with `result.text` and `result.artifacts`). Runs cost credits (Free 30 + 5/day; Pro $20 for 200;
extra $0.15 each). No stated runtime, latency or rate limits for the app-scoped path. Keys are server-side secrets.

**Does it genuinely help?** Not the core. DroneX's value is a deterministic physics verdict over sourced data,
real ArduPilot in the loop and a live 3D map. Creao is asynchronous, credit-metered and LLM-driven with no latency
guarantee; in the verdict, export or flight path it would make the product slower and less trustworthy and
contradict "computed by physics, not by a model". It does help the parts that are manual, slow and human-shaped:
getting real parts and numbers into the catalog, and getting results out to people.

**Existing features that get better.**
- The parts dataset: an agent with Browser Use pulls thrust tables, weights, discharge ratings and prices from
  manufacturer pages on a schedule and opens a GitHub pull request with the record and its source URL. A human
  merges, so "nothing is invented" holds.
- "Unknown" fields: a scheduled agent hunts the missing datasheet values and fills them with sources.
- Mission test results: the per-requirement verdict becomes a printable build report with bill of materials,
  prices and the physics table, sent by email or Slack.
- Nothing in the configurator, the exporter or the simulator gets faster; those are local and instant already.

**New features it makes possible.**
- Live sourcing: current price and stock per part from two or three vendors, refreshed nightly.
- Order the build: after a design survives simulation, an agent assembles the cart across vendors, gated by approval.
- Print-farm handoff: a passing design's STL list and print settings go to a Notion/Sheets job board and Slack.
- Community hangar curation: submitted designs are physics-checked through our API, a review is drafted, a human
  approves. One person runs the hangar like a team (the Track 02 story).
- Pre-flight notes: airspace restrictions and forecast wind for the real place, written into the mission card.

**Track fit.** 01 is a bad fit (it demands the app stops working without the agent, which means weakening the
physics core). 02 fits well: one agent per role (sourcer, datasheet reader, hangar reviewer, report writer,
procurement) coordinated by a schedule or an API-Trigger orchestrator, with one human running a drone design
house. 03 is weaker (print-farm and notifications).

**Coexistence with Fetch.ai.** Fetch.ai is the user-facing layer where intent becomes a flight; Creao is the back
office that keeps the catalog real and ships the paperwork. Different parts of the product, both presentable as
planned from the start.

**Needs.** A Creao account (Pro for premium models and more credits), connector OAuth (GitHub, Slack, Sheets or
Notion), a `capi_` key kept server-side, a public webhook URL or polling, and one HTTP route in the configurator
for the physics check if hangar curation is built.

**Risks.** Credits at $0.15 past the allowance; Browser Use on vendor sites breaks when pages change; API Trigger
results are best-effort async, so anything built on it needs polling as a fallback; runs that fail before starting
send no webhook.

**Decision:** undecided.

Docs: creao.ai · creao.ai/pricing · docs.creao.ai/pro/api-trigger · docs.creao.ai/developer-api/api-paths ·
docs.creao.ai/developer-api/quickstart

---

## CRS Credit API: finance the build

**Challenge:** CRS Financial Intelligence Challenge at Cal Hacks 13.0. Only rule: make meaningful use of the CRS
sandbox and show it working live in the demo. Judging (no points formula): originality, usefulness, CRS at the
core (not a bolt-on), it really works, responsible. Prizes: Best Overall CRS Hack $2,000, Best Financial AI Agent
$1,000, Best Identity / Fraud Innovation $500, Most Unexpected Use of CRS (interview for a forward-deployed
engineer role).

**What it is.** CRS is a licensed credit reporting agency that resells bureau data as one API: consumer credit
reports (Equifax, Experian, TransUnion, single or tri-merge, soft or hard pull, FICO and VantageScore), real-time
prequalification by soft inquiry, business credit (FICO SBSS, Intelliscore, company debt and state filings),
identity verification (ID, KBA, one-time passcodes, documents, prefill), public, criminal and eviction records,
and compliance checks (OFAC watchlist, Military Lending Act). Sandbox: `https://api-sandbox.stitchcredit.com/api`,
login at `/users/login` for a Bearer token, sample endpoint
`/experian/credit-profile/credit-report/standard/exp-prequal-vantage4`, synthetic personas only, Postman
collection and OpenAPI specs by email, an MCP server (`@crscreditapi/crs-calhacks-mcp-server`) for development
help. Average response under 2 seconds. Production access needs permissible-purpose vetting by CRS's compliance
team (letter of intent, signer ID, sometimes a site inspection), usually about two weeks.

**Does it genuinely help?** Not the aspects DroneX is about. Credit, identity and fraud data have no bearing on
whether a motor lifts a propeller, whether a pack lasts the mission, or how a copter flies between buildings.
The physics verdict, the exporter, the simulator and the 3D map gain nothing. "CRS at the core" cannot be met
honestly without turning DroneX into a different product, so Best Overall is out of reach. Where CRS fits is the
step our story currently skips: the design has passed, now someone has to pay for the parts, and for a clinic,
a co-op or a fire department that is a financing and procurement decision. CRS also fits a step we should have
anyway: drones are dual-use hardware, and screening who receives a kit is a real obligation.

**Existing features that would change.**
- The verdict and the mission test gain a cost line: bill of materials from the catalog's sourced prices, and
  "affordable as a one-off / on a payment plan" from a soft-pull prequalification. The physics numbers stay as
  they are.
- The Hangar entry summary gains fleet cost and, for an organisation, a financing readiness line from business
  credit (FICO SBSS). Nothing else in the configurator changes.
- The Fetch.ai dispatcher (if built) gains one step after the review card: "can this operator finance the drone
  that passed?", which also makes it a candidate for Best Financial AI Agent.
- Nothing gets faster. Every CRS call is a network request of about 2 seconds added to a flow that is instant today.

**New features it makes possible.**
- Finance the build: after a design survives simulation, a soft-pull prequalification (no score impact) shows the
  monthly payment for the parts list against two or three financing terms, and which parts to downgrade to fit a
  budget while still passing the mission. Design, simulate, finance, print.
- Fleet financing for organisations: a co-op or clinic enters its business details, CRS business credit and SBSS
  size the fleet it can fund, and the mission matrix shows what that fleet can do.
- Operator onboarding and kit-release screening: identity verification, OFAC and watchlist checks before a
  design is released to print or a kit ships, since drones are dual-use hardware. This is the genuinely
  unexpected use and the one that is defensible as responsible.
- Marketplace trust: identity verification for people selling designs or parts in a community hangar, and fraud
  signals on suspicious listings.
- Affordability-aware recommendations: the part swap that fixes a failing mission is ranked by what the builder
  can actually afford, not only by physics.

**Track fit.** Best Overall: no, CRS cannot be the core. Best Financial AI Agent: plausible if combined with the
Fetch.ai dispatcher (an agent that designs, verifies, then prequalifies the financing). Most Unexpected Use:
plausible with kit-release screening (OFAC and identity for dual-use hardware). Best Identity / Fraud: weak.

**Needs.** CRS sandbox credentials (email invite, portal, Postman collection); catalog prices per part (some
records lack them); a server-side route in the configurator that calls the sandbox (keys never in the browser);
synthetic personas only, never a real SSN in a demo; a clear "soft pull, no score impact" disclosure in the UI;
if combined with Fetch.ai, the dispatcher gains one tool. Production would need permissible-purpose vetting,
which is out of scope for a hackathon.

**Risks.** It dilutes the story if it leads; it must be the last step, not the first. The judges' "CRS at the
core" criterion works against us whatever we do. Real financing products carry FCRA and adverse-action duties
we would only be able to gesture at. Sandbox data is synthetic, so the demo cannot show a real builder's numbers.

**Decision:** undecided. Recommendation: skip unless we want a side entry; if we enter, build "finance the build"
plus kit-release screening as the final step after simulation, aimed at Most Unexpected Use and, with the Fetch.ai
dispatcher, Best Financial AI Agent.

Docs: calhacks.crscreditapi.com · crscreditapi.com/resources/credit-api · crscreditapi.redoc.ly ·
crscreditapi.com/developers-guide-crs-credit-api

---

## Cartesia: voice copilot for the simulator

**Challenge:** Best Use of Cartesia. Only rule: build a useful voice experience with Cartesia; voice must be core
to the product, not a feature added for the demo; other tools are fine but make clear what Cartesia contributes.
Docs docs.cartesia.ai, playground play.cartesia.ai.

**What it is.** Three products behind one API key. Sonic 3.6 text-to-speech: streaming over WebSocket, about
90 ms to first audio as stated by the vendor (independent measurements 170 to 440 ms end to end), 44 languages,
pacing and intonation from the text itself, numbers and codes read correctly, instant voice cloning from a
10-second clip on paid plans. Ink 2 speech-to-text: streaming transcription with built-in turn detection, about
100 ms transcript latency as stated. Managed Agents: Cartesia hosts the loop (Ink, an LLM you pick, Sonic),
handles turn-taking and interruptions, calls webhook or client tools, and can sit on a phone number. Pricing:
Free 20K credits (about 27 minutes of speech, about 1.9 hours of transcription, 2 concurrent TTS, no cloning, no
commercial licence), Pro $5 for 100K credits and cloning, agents $0.06 per call minute. Python and JavaScript SDKs.

**What we have today.** The simulation engine has an AI assistant tab: typed natural language ("hover around the
Palace of Fine Arts", "return to launch", "move the alpha 10 m up") turned into Core RPC tool calls by the
daemon's agent crate (provider-agnostic LLM, tools generated from the API contracts: `command/send`,
`plan/route`, `plan/upload`, `telemetry/get`, `place/search`, `sim/*`). The Get started guide coaches the first
flight in text. Keyboard flying exists. The configurator has no voice; its xAI client (speech, transcription,
realtime) is unused and documented as "kept for later".

**Does it genuinely help?** Yes, for the simulation engine, and honestly so: aviation is voice-native. A pilot's
hands are on the controls and eyes on the aircraft; air traffic control, callouts and checklists are spoken for
that reason. In our simulator you cannot type while flying from the keyboard, and the text assistant already
knows how to act. Voice in (Ink) and callouts out (Sonic) turn it into a copilot, which is the core of the
flying half of the product, not a bolt-on. For the configurator the case is weak: building a drone is a visual,
pointing task; narration is a convenience.

**Existing features that get better.**
- The AI assistant: spoken commands instead of typing, with barge-in, while the hands stay on the keys. Same
  tools, same safety gating (arming and mode changes still confirm, now by voice).
- Building avoidance: the brake in front of a wall and the reroute around towers become spoken warnings
  ("building ahead, 40 metres, braking") instead of a banner the pilot may not be looking at.
- Mission leg warnings and the one-click reroute: spoken, with "reroute" or "keep it" as the answer.
- The Get started guide: a spoken coach for the first flight, step by step, reacting to what the vehicle does.
- Fly in simulation hand-over: the pack, start and parameter steps narrated, so the 3 to 10 seconds of transition
  are not silent.
- Telemetry the pilot asks about ("what's my battery", "how high am I") answered aloud from `telemetry/get`.
- Nothing gets faster. Each spoken answer adds roughly 0.2 to 0.5 seconds of synthesis after the tool call.

**New features it makes possible.**
- Voice copilot callouts: altitude and battery at thresholds, mode changes, GPS and EKF health, "home set",
  "mission leg 3 of 7", the way a real flight controller's ground station speaks, driven from the telemetry
  subscription rather than an LLM so they are deterministic and instant.
- Hands-free Go to by place name: "go to the Ferry Building at sixty metres" through `place/search` and
  `plan/route`, with the building-aware path spoken back before it is flown.
- Spoken pre-flight checklist for the design on the pad: battery, hover margin, mission requirements, read from
  the physics verdict, with the pilot answering "check".
- Multilingual operation (44 languages): the clinic or co-op operator flies in their own language, which matches
  the pitch's rural and global users.
- Call your drone: a Managed Agent on a Cartesia phone number answers "where is it, how much battery" from the
  telemetry, for a dispatcher without a screen. Unexpected and cheap ($0.06 per minute).
- Spoken part explanations in the configurator: click a part, hear what it does and where its numbers come from.
  A convenience, listed for completeness.

**Where it would live.** The simulation UI is a prebuilt bundle, so the voice layer goes in a thin "Copilot"
overlay served by the configurator (Next.js): the browser streams the microphone to Ink with a short-lived
client token, transcripts go to a server route that calls Core over the unix socket (the agent for free-form
intents, direct RPC for callouts and telemetry questions), replies are synthesised with Sonic over WebSocket and
played in the browser. Callouts come from a server-side `telemetry/subscribe`. Keys stay server-side. If Managed
Agents is used, Core RPC calls become webhook tools on our server.

**Track fit.** Strong. Voice is core to the flying half, the contribution of Cartesia is clear (every spoken word
in, every word out), and the demo is live: fly a mission by voice while the copilot calls out buildings and
battery. The phone-in dispatcher is the surprise.

**Needs.** A Cartesia API key (Free tier covers a demo; Pro at $5 for cloning and the commercial licence);
a quiet room and a decent microphone for judging; a decision on which LLM the agent uses for free-form intents
(the daemon's existing agent config, or Cartesia's managed LLM); a `/copilot` overlay in the configurator plus
one server route and a telemetry subscriber; synthetic callout thresholds agreed (battery 30/20/10 %, altitude
bands, distance to building).

**Risks.** Demo-hall noise defeats speech recognition; have the keyboard path as fallback and the barge-in
tuned. Latency stacks: transcription, tool call, synthesis; keep callouts LLM-free so they stay under half a
second. Arming and mode changes by voice need an explicit confirmation step or they are unsafe. Free tier allows
only 2 concurrent TTS streams, enough for one copilot. Sonic reads numbers well, but telemetry phrasing needs a
small template layer so "37.76097" is never spoken.

**Decision:** chosen on 2026-10-25; being built at `/copilot` in the configurator. Recommendation was: the strongest fit of the four so far. If entered, build the simulator
copilot first (commands, callouts, building warnings), then the phone-in dispatcher if time allows; leave the
configurator narration out.

Docs: docs.cartesia.ai · docs.cartesia.ai/build-with-cartesia/tts-models/latest · docs.cartesia.ai/build-with-cartesia/stt/latest ·
docs.cartesia.ai/agents/introduction · cartesia.ai/pricing · play.cartesia.ai

---

## Bitdeer AI Model Studio: the brain behind the assistant

**Challenge:** Best Use of Bitdeer AI Model Studio. Build an AI-powered application using it; agents, developer
tools, productivity, creative experiences or anything else qualify. No other rule.

**What it is.** A serverless inference API for self-hosted open-weight models behind one OpenAI-compatible
endpoint (`https://api-inference.bitdeer.ai/v1`, Bearer key, the OpenAI SDK works with a changed base URL).
Documented: `/v1/chat/completions` with streaming, vision, function calling and structured outputs; embeddings
(`BAAI/bge-m3`); rerank (`BAAI/bge-reranker-v2-m3`); image generation (`seedream-5.0-lite`). Catalogue at the time
of writing: DeepSeek-V4.1-Flash and V4-Flash, GLM-5.3 and GLM-5.3-Flash, Qwen3.8-27B (vision), NVIDIA
Nemotron-3.5-Super-VL-120B, Kimi, MiniMax, Qwen3.5-397B. Integrations listed for LangChain, OpenAI Agents SDK,
LiteLLM, Dify, Cursor and Claude Code. Pay as you go; the pricing page did not render its table for us and no free
or hackathon credits are stated, so confirm both with the sponsor. Not documented: an OpenAI Responses API
endpoint (`/v1/responses`), reasoning controls, fine-tuning of hosted models, rate limits, regions.

**What we have today.** The simulation engine's AI assistant is provider-agnostic in principle: an Anthropic
provider and an OpenAI provider with a configurable `api_base`. The OpenAI provider, however, calls the Responses
API (`/responses`), which Bitdeer does not document, so it cannot be pointed at Bitdeer as is. The configurator
has an unused xAI client meant for a design advisor (JSON answers), image generation and voice. The physics
verdict is deliberately not a model.

**Does it genuinely help?** Not by itself. Bitdeer is a place to run a model, not a capability DroneX lacks. The
things the product is about (the physics verdict, the exporter, the simulator, the 3D map, building avoidance)
neither use nor need an LLM, and the pitch promises they never will. What Bitdeer can do is be the model behind
the two places where an LLM is legitimate: the simulator's natural-language assistant (today pointed at a
proprietary API) and the configurator's not-yet-wired advisor. That is a provider decision with three honest
upsides: open-weight models (the "open stack, run it on a laptop in a town with no cloud" story is more credible
when the model is open too), function calling and structured outputs for tool use and JSON verdict explanations,
and one key for chat, vision, embeddings and images. It is also an "Best Use" track with no rule beyond using it,
so the bar for eligibility is low, which cuts both ways: judges will look for whether the model does real work.

**Existing features that get better.**
- The simulator's AI assistant: runs on an open-weight model with function calling through Bitdeer. Requires a
  chat-completions adapter in the daemon's OpenAI provider (it speaks the Responses API today), about a day of
  Rust. Quality depends on the chosen model's tool-calling reliability; DeepSeek-V4.1-Flash or GLM-5.3 are the
  candidates to test first.
- The configurator's design advisor, currently unwired: "why did this fail, what should I swap" answered in
  structured JSON over the physics verdict and the catalog. The numbers stay from code; the model only explains
  and proposes swaps that the verdict then re-checks.
- The Fetch.ai dispatcher (if built) can use Bitdeer for intent parsing instead of ASI:One, and the Cartesia
  copilot (if built) for free-form intents. Not faster, but one open model across the three.
- Nothing gets faster or more efficient. Every path that is instant today stays instant because none of them
  call a model.

**New features it makes possible.**
- Explain-the-verdict: a structured, cited explanation of every pass/fail line, with the exact dataset records
  and formulas the physics used, so a first-time builder understands the result. Structured outputs keep it
  machine-checkable.
- Swap search: "make this design pass the delivery mission under 2 kg and 20 minutes" as a loop of model
  proposals from the catalog, each re-run through the physics in code, returning only designs that pass.
- Photo-to-build: a vision model (Qwen3.8-27B, Nemotron VL) reads a photo of a bench full of parts or a vendor
  listing and drafts a build from catalog matches, for the builder who already owns hardware.
- Datasheet ingestion: vision plus structured outputs turn a motor's PDF thrust table into a catalog record with
  its source URL, feeding the "nothing is invented" dataset faster (the same job proposed for Creao, done with
  our own code instead of a no-code agent).
- Semantic hangar search and part matching with `bge-m3` embeddings and the reranker: "quiet indoor quad for
  inspection" finds designs and parts by meaning.
- Mission-report illustration with `seedream-5.0-lite`: a rendered hero image of the design over its mission
  area for the printable report. Cosmetic.

**Track fit.** Eligible with little effort and defensible if the model does real work: tool-calling assistant,
verdict explanations, swap search, photo-to-build. Weak if it is only a provider swap. Best story: "an open
model, hosted on Bitdeer, is the only LLM in DroneX, and it never computes a number, it explains them and acts
on them." Pairs naturally with Fetch.ai and Cartesia as their shared model.

**Needs.** A Bitdeer API key and clarity on credits or pricing from the sponsor; a chat-completions adapter in the
daemon's OpenAI provider (or a small local proxy translating Responses to chat completions) if the simulator
assistant is to use it; a server-side route in the configurator for the advisor (keys never in the browser);
a tool-calling evaluation of two or three catalogue models before committing; the catalog needs machine-readable
formula references for cited explanations (partly there).

**Risks.** Open-weight tool calling is less reliable than frontier models; test before the demo. No documented
rate limits or SLAs; keep a fallback provider configured. Pricing unknown at assessment time. A "provider swap"
reads as a bolt-on to judges unless the explain, swap-search or vision features ship. The Responses-vs-chat
mismatch is real engineering, not configuration.

**Decision:** undecided. Recommendation: worthwhile only bundled with features that need a model anyway
(explain-the-verdict and swap search in the configurator, or as the brain of the Fetch.ai dispatcher and Cartesia
copilot). Do not enter it as a provider swap alone.

Docs: developers.bitdeer.ai · developers.bitdeer.ai/docs/guides · developers.bitdeer.ai/docs/api/models-catalog ·
bitdeer.ai/en/services/ai-inference · bitdeer.ai/en/pricing/ai-models

---

## Moss: sub-10 ms retrieval inside the app

**Challenge:** Best Use of Moss ($996 cash plus AirPods Max at Cal Hacks 13.0). Three examples they want:
1. Voice AI, voice agents that listen, respond and act in real time; 2. Personal Agent, an agent that remembers
you, works across your apps and handles everyday tasks; 3. Social Post, best engagement. No other rule.

**What it is.** Moss (moss.dev, YC F25) is a retrieval layer that runs inside your process: you create a named
index from documents (`id`, `text`, optional metadata) through the SDK, Moss Cloud embeds them with built-in
models (or yours), and at startup the runtime downloads the vector index over HTTPS, keeps it in memory and
answers every query locally, semantic and hybrid keyword in one call, with metadata filters (`$eq`, `$in`,
`$and`, `$near`), top-k and a reported P50 of 3.1 ms and P99 of 5.4 ms over 100,000 documents on a laptop.
SDKs: Python 3.10+, TypeScript/Node 20+ (`@moss-js/moss`), browser WebAssembly (`@moss-dev/moss-web`, queries
fully client-side), Elixir, C. Document changes flow through Moss Cloud and the runtime stays in sync.
Pitched for voice agents (LiveKit, Pipecat, Vapi integrations) because a cloud vector database adds 300 to 900 ms
of dead air in a conversation. Pricing page was empty at assessment time; a free developer tier is reported by
third parties; "Moss Inference" is in private beta. Index size limits not stated.

**What we have today.** The configurator has no search: the Hangar is a fixed list of presets, part pickers are
filtered by compatibility only, and the dataset is small (7 airframes, 10 motors, 9 propellers, 8 batteries, 5 payloads, 6 missions and 8 presets; 53 records in all). The simulator has `search/query` (threads, vehicles, parameters, missions, telemetry, settings,
saved places) and `place/search` (hosted API for towns, landmarks and addresses). The simulator's AI assistant
offers the model 131 tools, every one in the prompt on every turn. Nothing in the product is retrieval-bound.

**Does it genuinely help?** A little on its own, a lot as part of the voice copilot. On its own: our catalog is
53 records, so any search over it is already instant; Moss would make "find me a quiet
indoor quad for inspection" or "a 6S pack under 1.5 kg with a source" possible by meaning rather than by filter,
in the browser, with no server. That is useful and cheap, but it is not what the product is about and a judge
would call it a feature. Paired with Cartesia it becomes structural: a voice copilot must answer inside the
200 ms people notice, and every lookup it does (which part, which place, which tool, which parameter, which
guide step) is a retrieval on the critical path. Moss is the layer that keeps those lookups local and under
10 ms, and the Voice AI example is exactly that pairing.

**Existing features that get better.**
- Part pickers and the Hangar: semantic and hybrid search over parts and designs, client-side, with filters on
  compatibility metadata (cells, mount pattern, propeller size, airframe type). Instant, offline after first load.
- The simulator's assistant: 131 tools in every prompt become a retrieval step that selects the 8 to 10 relevant
  ones per utterance, which cuts prompt size and tool-choice errors. Parameter lookup ("what does MOT_THST_HOVER
  do") over ArduPilot's parameter documentation becomes a 5 ms local query instead of a model guess.
- `place/search` for Go to: a local index of the demo area's landmarks and addresses answers "the Ferry
  Building" without the hosted API round trip, so a spoken Go to resolves instantly; the hosted search remains the
  fallback for places outside the index.
- The Get started guide and the physics "where does this number come from" notes: searchable by question.
- Nothing gets slower; the first index load adds one HTTPS download at startup, cached after.

**New features it makes possible.**
- Voice copilot lookups under 10 ms (with Cartesia): "go to the pier by the ballpark", "set the hover throttle
  parameter", "what is the courier's endurance", each resolved by local retrieval before the model or the tool
  call, so the spoken answer starts inside the conversational gap.
- Natural-language part and design search in the Hangar, client-side: by purpose, constraint and even failure
  ("a motor that fixes the thrust-to-weight on this hex").
- Verdict and datasheet question answering: index the catalog records, their source notes and the formula
  descriptions in the physics code, answer "why is the discharge margin red" with the relevant records and
  formulas, cited, with or without an LLM.
- A persistent pilot memory for the Personal Agent example: index the operator's own flights, designs, places
  and preferences (from the simulator's history and the configurator's saved designs) so the assistant remembers
  "the mapping route I flew yesterday" and "my usual battery". The data is already in the two engines; Moss is
  the recall.
- Community hangar search once designs are shared: thousands of designs searchable by meaning in the browser.

**Track fit.** Voice AI: strong only with Cartesia; Moss alone is not a voice agent. Personal Agent: plausible
as the pilot memory described above, and it also strengthens the Fetch.ai dispatcher. Social Post: not a
product fit; skip. Judges will want to see the latency argument live: show the voice copilot answering a lookup
with Moss on and the dead air with a cloud call instead.

**Needs.** A Moss project (`project_id`, `project_key`) and clarity on free-tier limits; an index build step in
the configurator (Node SDK at build time or a small script) over parts, designs, guide steps and formula notes;
the browser WASM package in the configurator or copilot overlay; for the simulator side, either the Node SDK in
the copilot server route or an index of tool descriptions and ArduPilot parameter docs; a local place index for
the demo area; metadata on records for filters (mostly present).

**Risks.** The catalog is small enough that judges may ask why retrieval is needed; the answer must be the
voice critical path or the personal memory, not the Hangar search. Pricing and index limits unknown. Embeddings
happen in Moss Cloud, so the index build needs network and the data leaves the machine once; fine for public
catalog data, decide for personal flight history. Browser WASM bundle size and first-load download should be
measured. Private-beta "Moss Inference" is not something to depend on.

**Decision:** undecided. Recommendation: do not enter Moss on its own; if Cartesia is chosen, add Moss as its
retrieval layer (tool selection, place and parameter lookup, part search) and enter both, with the Personal Agent
pilot memory as the stretch.

Docs: moss.dev · github.com/usemoss/moss · moss.dev/use-cases/voice-agents · docs.moss.dev/docs · portal.usemoss.dev

---

## SpaceXAI, Make it Legendary: real space data, Grok, Cursor

**Challenge:** "Space gives you more to work with than almost any other field: enormous public datasets, decades
of missions, a literature no human can read all of. Real space data goes in and a legendary project comes out."
Eligibility: the project must be built with Cursor, and the more Cursor is used the better; it must use the Grok
Imagine or Grok Voice API. Bonus for using Grok Bot for planning and team collaboration.

**What it is.** Two process rules (Cursor as the editor, Grok Bot for planning) and one technology rule: xAI's
Grok Imagine (image generation about $0.02 to $0.07 per image, video $0.02 to $0.25 per second depending on the
source and resolution) or Grok Voice (realtime speech-to-speech about $0.05 to $0.08 per minute, transcription
about $0.10 to $0.20 per hour, text-to-speech priced per million characters; figures from third parties, confirm
at docs.x.ai). Plus whatever public space data we choose.

**What we have today.** More space data than it looks. The simulator's terrain is the ALOS digital elevation
model (JAXA's satellite radar, with the EGM96 geoid), the 3D city is Google's photorealistic tiles (satellite and
aerial photogrammetry), the vehicle navigates by a simulated GNSS receiver through ArduPilot's EKF, and the
landing page dives from orbit past an Earth, Moon and Mars sized from NASA's planetary fact sheets. The
configurator already carries an xAI client (advisor, Imagine image model, voice transcription, speech, realtime
token) that was written for this and never wired: the Grok requirement was intended from the start. Cursor has
not been used on the repo so far.

**Does it genuinely help?** One idea does, honestly: GNSS realism. Drones crash in cities because buildings hide
satellites; the simulator today gives every vehicle a perfect fix everywhere. Real space data can fix that: pull
the GPS, Galileo, GLONASS and BeiDou orbits (TLEs from CelesTrak, public), compute which satellites are above the
horizon at the simulation's place and time, cut the ones the buildings (we already have their outlines and
heights) block from the vehicle's position, and feed the live count and dilution of precision into the SITL
(`SIM_GPS_NUMSATS`, `SIM_GPS_HDOP`, glitch and drift parameters) as the drone moves. A courier flying between
towers then loses position quality the way it does in life, the EKF reacts, the failsafes trigger, and our
building-aware routing gains a second reason to route over rather than between. That is "real space data goes
in" and it makes the flying half more truthful. The Grok rule is met by the copilot voice (which competes with
Cartesia: pick one) or by Imagine for mission briefing imagery (cosmetic). Cursor is a workflow change, not a
product change.

**Existing features that get better.**
- Simulation realism: GNSS satellite visibility and dilution of precision driven by real orbits and our building
  data, instead of a perfect fix. The EKF, failsafes and mode behaviour become honest in urban canyons.
- Building avoidance and routing: a route scored by GPS shadow as well as collision, with a spoken or shown
  reason ("between those towers you will have 4 satellites; going over keeps 11").
- Mission check in the configurator: a leg through a GPS shadow is flagged like a leg through a building.
- Terrain and tiles: already satellite-derived; present them as such in the UI and docs (no code change).
- The unused xAI client gets wired: voice for the copilot (if Grok is chosen over Cartesia) and Imagine for
  briefing images. Nothing gets faster.

**New features it makes possible.**
- GPS-shadow map of the city: where a drone can hold position and where it cannot, by hour, as a layer on the 3D
  map, from TLEs plus building geometry.
- Launch-window planning: the best time in the next hours to fly a mission for satellite geometry, the way
  surveyors already plan GNSS work.
- Degraded-navigation drills: fly the courier through a canyon with real satellite loss and practise the
  recovery; a Get started chapter.
- Space weather in the loop: NOAA's Kp index and ionospheric data scaling GNSS noise on the day (public, live).
- Mission briefing imagery with Grok Imagine: a rendered view of the design over the mission area for the
  printable report (cosmetic, listed because it satisfies the rule cheaply).

**Track fit.** Moderate to good if the GNSS work is done; weak if the entry is Grok plus the existing tiles. The
"legendary" pitch: "the only drone simulator where the satellites are real". Conflicts: Grok Voice versus
Cartesia for the copilot (do not run both), and the Cursor rule means the remaining work on this track has to be
done in Cursor, with Grok Bot in the planning, and shown.

**Needs.** An xAI API key (`XAI_API_KEY`, already expected by the client); Cursor installed and used for this
work; a TLE fetch and SGP4 propagation (a small library, Python or TypeScript) in a server route or in the
daemon; a line-of-sight check against the building footprints and heights we already load; a telemetry
subscription that writes the GPS SITL parameters as the vehicle moves; a GPS-shadow layer in the 3D map (the UI
is a prebuilt bundle, so via the copilot overlay or a patch).

**Risks.** Writing SITL GPS parameters at flight rate may fight the autopilot's parameter store; test the rate.
The building data is OpenStreetMap heights, coarse for shadowing. Grok pricing figures vary by source. Choosing
Grok Voice over Cartesia loses the Cartesia track and vice versa. Cursor is a hard eligibility rule.

**Decision:** undecided. Recommendation: enter only if the GNSS realism feature is built; pick Grok Voice or
Cartesia, not both; do the work in Cursor from the first commit of this feature.

Docs: docs.x.ai · celestrak.org (TLEs) · ardupilot.org/dev/docs/sitl-simulator-software-in-the-loop (SIM_GPS_* parameters)

---

## Convex: one live TypeScript backend for the configurator

**Challenge:** Best use of Convex. "Agent, healthtech, fintech, hardware, or full-stack side project. Build it on
Convex: database, functions, workflows, sync, search, and file storage in one TypeScript backend that updates
live. Use real Convex features like live queries and components to win."

**What it is.** A reactive database with TypeScript functions: queries that clients subscribe to and that update
live, mutations, actions for third-party calls, scheduled functions and cron, file storage with upload and
serving URLs, full-text and vector search, HTTP actions, authentication (Convex Auth, Clerk, Auth0, WorkOS, custom
JWT), and components as isolated mini-backends: Workflow (durable multi-step runs), Agent (threads, tools, RAG,
file handling), RAG, Rate Limiter. Clients for JavaScript, React, Swift, Kotlin, Python and Rust. Open source
and self-hostable. Free tier limits not confirmed at assessment time.

**What we have today.** Two ad hoc persistence layers. The configurator keeps every design sent to the simulator
in `.dronex/sim/<id>/` on local disk (design, profile, 6 MB model) and serves the model over HTTP to the map; the
"Open in DroneX" link only works on the same machine. The simulation engine has its own Node account backend
(auth, cloud sync, flight storage, relay and remote control, live video, watch links, places), written to
UXDuck's API contract so the Rust daemon can talk to it. Nothing is shared between people, and nothing updates
live between the two engines except through the daemon.

**Does it genuinely help?** For the configurator, yes, and in a way judges can see: designs, profiles and
models move from a local folder to a live, shared store with file storage, so the same drone can be opened on
the clinic's laptop and the dispatcher's phone, a hangar can be shared, and every screen that shows a design
updates when it changes. For the simulation engine, mostly no: the daemon's backend contract is UXDuck's and
replacing it is a rewrite for no product gain; the honest move is to mirror the telemetry we need (through the
daemon's `telemetry/subscribe`) into Convex for live fleet and watch views, and leave the daemon's own backend
alone. It is a platform choice, but the live sync and durable workflows are capabilities we do not have.

**Existing features that get better.**
- Fly in simulation: becomes a durable Workflow (pack, start, size, bookmarks, parameter writes with retries)
  with a live status the configurator shows, instead of fire-and-forget logging; a failed parameter write is
  visible and retried.
- Design and model storage: Convex file storage serves `model.glb` by URL to the map, so the "DroneX model"
  bookmark works from any machine and designs survive a reinstall.
- "Open in DroneX" and "bring it back and change it": work across machines and people.
- The Hangar: a live, shared table of designs (yours, your team's, the community's) instead of a fixed preset
  list; full-text and vector search over it (overlaps with Moss; Convex's is server-side, Moss's is in-process).
- Catalog sourcing: scheduled functions for the nightly datasheet and price refresh (overlaps with Creao; this
  is our own code).
- Nothing in the physics, exporter, simulator or 3D map gets faster.

**New features it makes possible.**
- Live fleet view for an organisation: several operators' simulated or real vehicles on one screen, mirrored
  telemetry via live queries, the dispatcher sees what every pilot sees.
- Watch links: share a live flight with a client or instructor as a URL, from the mirrored telemetry.
- Collaborative design: two people editing one build with live updates, review and approve before printing.
- Agent threads with history: the Convex Agent component as the memory and tool runner behind the Fetch.ai
  dispatcher or the Cartesia copilot, with the Workflow component running the mission end to end durably.
- Print-farm job board and procurement queue (the Creao ideas) as plain tables with live status.
- Accounts for the configurator (Convex Auth), so designs belong to people.

**Track fit.** Good if sharing or multi-user is part of the demo; the live queries and the Workflow component are
"real Convex features" in the sense the judges ask for. Weak if Convex only replaces the local folder.

**Needs.** A Convex project and deployment URL; a schema for designs, profiles, models, flights, telemetry
mirror and hangar; migration of `store.ts` and the three API routes to Convex functions and file storage; a
telemetry mirror process (Node, reading the daemon's unix socket) writing to Convex; React hooks in the
configurator for live views; a decision on auth. The daemon's backend stays as it is.

**Risks.** Two backends in one product (the daemon's and Convex) need a clear boundary or the architecture
story gets muddy. The 6 MB models (2.7 MB after the exporter fix) are fine for file storage but a telemetry
mirror at 10 Hz per vehicle should be rate-limited to stay inside free-tier bandwidth. Live queries over the
unix-socket daemon need the mirror process running; it is one more thing `dev.sh` starts.

**Decision:** undecided. Recommendation: adopt it as the configurator's backend if the demo includes sharing,
a fleet view or the durable Fly workflow; otherwise it is a provider swap like Bitdeer.

Docs: docs.convex.dev · docs.convex.dev/agents/overview · convex.dev/components

---

## Microsoft: Built for the Real World and Customer Impact Award

**Challenge:** Grand Prize: "Build a production-minded AI agent that solves a meaningful problem in finance,
productivity, healthcare, or another high-impact domain." Judging: customer understanding, measurable
usefulness, path from prototype to production, responsible design, end-to-end functionality. The Customer
Impact Award uses the same brief. No Microsoft or Azure technology is named in the brief we were given; we could
not reach the Devpost page to confirm whether one is expected, so check with the Microsoft booth.

**What it is.** Not a technology: a framing track that rewards a product with a real customer, an agent that
does the job end to end, numbers that show it helps, and a credible road to production.

**What we have today.** A customer story (the rural clinic's courier, the farm co-op, the fire department), a
deterministic physics verdict with sources, a simulator running the real autopilot over a real city, one AI
agent (the simulator's assistant, text, tool-calling) and one planned (the Fetch.ai Dispatch, intent to flight).
We do not yet measure usefulness, we have no safety and responsibility write-up, and the agent is not the spine
of the flow.

**Does it genuinely help?** It does not add anything to the product. It tells us what to make explicit and what
to finish: the agent has to carry the primary workflow end to end, the usefulness has to be measured, and the
responsible-design story has to be written and enforced in code. All three are things the product should have
anyway, so the track is a forcing function rather than a feature.

**Existing features that would change.**
- The Dispatch agent (Fetch.ai plan) or the simulator assistant becomes the spine: request, candidate drones,
  verdict, flight, report, with confirmations at every irreversible step.
- Instrumentation: count design iterations, reprints avoided (hours and grams of filament at the airframe's
  print estimate), simulated mission passes and failures, time from intent to first flight; show them on a
  small metrics page and in the report.
- Responsible design made concrete: the verdict is code not a model (already), arming and mode changes need
  explicit confirmation (already in the daemon's capability model, make it visible), geofence and altitude
  limits per mission, a "not for real flight without a licensed pilot" notice, dual-use awareness (the CRS
  screening idea if we want it), data handling notes.
- Path to production: the open-stack story (self-hosted backend, open simulator core, ArduPilot), a deployment
  sketch (where the daemon runs, where the configurator runs, what a clinic installs), and what is missing
  (airframe dynamics, structural analysis, weather), stated plainly.

**New features it makes possible.** None by itself. If a Microsoft technology turns out to be expected, the
plausible additions are Azure AI Foundry or the Microsoft Agent Framework hosting the Dispatch agent, Azure
OpenAI as its model, and Azure Blob for models and reports; each is a provider swap in the same places Bitdeer
and Convex were assessed.

**Track fit.** Good if the Dispatch agent is built and measured; it is the same work as the Fetch.ai plan plus a
metrics page and a responsibility section. Weak as the product stands, because the agent is not yet the spine.

**Needs.** Confirm at the booth whether Azure or the Agent Framework is required. Build the Dispatch agent (see
Fetch.ai). Add a metrics page and event logging in the configurator and the fly route. Write `docs/RESPONSIBLE.md`
and a production sketch in ARCHITECTURE.md. Rehearse the end-to-end demo from a customer's words to a landed
vehicle and a report.

**Risks.** Judges will probe the customer claim; have one real conversation with a clinic, co-op or volunteer
fire department to quote. Measurable usefulness in a two-day hackathon is a proxy (simulated runs), say so.
Healthcare framing (blood samples) invites questions about regulation (Part 107, BVLOS waivers); the honest
answer is "the simulator is where you find out before you ask for the waiver".

**Decision:** undecided. Recommendation: treat it as the judging lens for the Fetch.ai Dispatch build rather
than a separate integration; if the Dispatch is built, enter both Microsoft prizes with no extra technology
unless the booth says otherwise.

---

## Apify: a datasheet and thrust-table Actor for the catalog

**Challenge:** Best use of Apify (top 5 projects using Apify in a meaningful way, judged on project quality and
other criteria) and Best Actor (building an Actor for this event). Same brief for both.

**What it is.** An Actor is a serverless cloud program: a Dockerfile, an input schema (which also generates its
UI), an output dataset and key-value store, a README, versions. Actors run from the console, the API, the CLI or
a schedule, can call each other, and can be private or published in the Apify Store (15,000+ ready-made
Actors; free, rented monthly, or pay per result). Built in JavaScript or Python, typically with Crawlee and
Playwright, with Apify's proxy and retries. Free plan about $5 of monthly usage at $0.20 per compute unit; the
Creator plan is $1 a month for about $500 of usage over six months for people building Actors. Figures from
Apify's pricing pages, which disagreed slightly between mirrors; confirm on apify.com/pricing.

**What we have today.** The catalog is 53 hand-entered records across 7 airframes, 10 motors, 9 propellers,
8 batteries, 5 payloads, 6 missions and 8 presets. Every record carries a source URL and quoted spec lines in
its notes; 8 of the sources are Wayback Machine captures because manufacturer pages vanished; many fields are
`null` ("unknown says so"): internal resistance on 8 motors, material and hub diameter on 5 propellers, mount
patterns, drag coefficients. The physics uses static propeller coefficients and motor constants, while the
README itself says "motor thrust tables live on one manufacturer's site, propeller coefficients on a forum".
Buildings come from OpenStreetMap through Overpass and are cached for a month.

**Does it genuinely help?** Yes, for the one thing the product says is its foundation and that is weakest today:
real numbers with receipts. Scraping is exactly Apify's job (browsers, proxies, retries, schedules, a Store to
share the result), and the data we need is scattered across retailer spec tables, manufacturer pages that
disappear, APC's per-propeller performance files and T-Motor's per-propeller thrust test tables. An Actor that
takes a part URL or name and returns a record in our schema, with the source URL, the quoted spec lines and a
Wayback snapshot request, fills the nulls and keeps the receipts alive. A second Actor (or mode) that pulls
measured thrust and power tables lets the verdict move from estimated coefficients to measured curves. That is
a genuine improvement to the verdict's truthfulness, which is the product's core claim. It is, however, offline
tooling: it runs before the demo, not during it, unless we show a live run and the verdict changing.

**Existing features that get better.**
- Catalog completeness: the `null` fields get filled with sourced values; "unknown" becomes rarer.
- Verdict accuracy: thrust per motor, hover current and endurance from measured thrust tables (APC performance
  data, T-Motor test tables) instead of static coefficients, each number labelled "measured" instead of
  "estimate" where we have the table.
- Source preservation: every cited page gets a Wayback snapshot, so the 8 archive links become the norm, not the
  rescue.
- Bill of materials: live prices and stock from two or three retailers, refreshed on a schedule (the same idea
  as under Creao and Convex; this is the right tool for the scraping part).
- Nothing in the app gets faster; the Actor runs on Apify's cloud on a schedule or on demand.

**New features it makes possible.**
- "Add a part by URL" in the Hangar: paste a product page, the Actor returns the record, the verdict re-runs.
  Shown live, this is the meaningful use judges ask for.
- Measured-curve physics: the propeller model reads real RPM, thrust and power tables when present.
- Community knowledge: an Actor over forum threads (RCGroups, IntoFPV) for "known failures of this motor and
  propeller pair", surfaced as a warning on the part card with the thread as the source.
- Airspace and advisories: an Actor over FAA UAS facility maps and NOTAM feeds for the mission area, feeding the
  mission check (public data, scheduled).
- The Best Actor entry: "Drone Part Datasheet" published on the Store, useful to every drone builder, with our
  record schema as its output schema and pay-per-result pricing.

**Track fit.** Good for Best Actor if the datasheet Actor is published with a clean schema and README; good for
Best use of Apify if the demo shows a live run changing a verdict from estimate to measured. Weak if Apify only
ran once before the event to fill the catalog.

**Needs.** An Apify account (Creator plan); an Actor in Node with Crawlee and Playwright, our record schema as
the output schema, and the notes convention (quoted spec lines) kept; parsers for APC performance files and
T-Motor test tables; a review step (pull request or in-app approval) so nothing enters the catalog unreviewed;
a server route in the configurator that starts a run and reads the dataset for "add a part by URL".

**Risks.** Retailer and manufacturer terms of service and anti-bot measures; pages change and parsers break;
data quality varies (two revisions of the same motor with different numbers, as the F60 record already notes),
so the review step is not optional. Free-plan usage is small; the Creator plan fixes that. Overlaps with the
Creao sourcing idea (Apify is the better tool for scraping; Creao for the office work around it).

**Decision:** undecided. Recommendation: worth doing for the product regardless of prizes, because it attacks
the weakest part of the core claim; enter Best Actor with the published datasheet Actor and show "add a part by
URL" live.

Docs: docs.apify.com/platform/actors · docs.apify.com/api · apify.com/pricing · crawlee.dev · apcprop.com (performance data)

---

## Elastic: search and analytics over the flight data exhaust

**Challenge:** Grab a free Elastic Cloud Serverless project; install the Elastic agent skills in your coding
agent; get your data into a `semantic_text` field; give it an agent and a workflow; find the signal.

**What it is.** Elastic Cloud Serverless (Elasticsearch, Kibana, 14-day free trial) with `semantic_text`, a
field type that embeds content at ingest through Elastic's inference service and is queried with a plain
`match` query or ES|QL; Agent Builder (generally available), which creates agents over your indices with tools
that inherit your access controls; Workflows (technical preview, YAML) for automation that runs inside the
stack and can be exposed as agent tools; and Agent Skills, an open-source skills repository for Claude Code and
Cursor installed with `npx skills add elastic/agent-skills`.

**What we have today.** A product that produces a lot of data and searches none of it. The simulator records
MAVLink history, telemetry windows and a journal for every flight, at telemetry rate across dozens of fields;
the History tab shows one flight at a time. The physics verdict and mission tests produce pass/fail lines per
design per run and keep none of them. ArduPilot has over a thousand parameters with documentation that the
assistant can only guess at. The catalog records carry quoted datasheet notes. Logs from the daemon, the SITL
and the configurator go to a terminal.

**Does it genuinely help?** Yes, and differently from every other track assessed: Elastic is for the data the
product already exhausts. Index every simulated flight (telemetry, events, mode changes, EKF variances, GPS
quality, building-avoidance brakes, mission legs) and every verdict, and questions nobody can answer today
become ES|QL: which designs lose GPS between the towers, how far does the courier's battery sag against the
estimate, which part swaps correlate with mission failures, how often does the brake fire. Put ArduPilot's
parameter documentation, the catalog notes and the physics formula notes into `semantic_text`, and the
assistant's "what does MOT_THST_HOVER do" is answered from the manual instead of a model's memory. An Agent
Builder agent over those indices is the "find the signal" agent; a Workflow that scores every new flight and
flags anomalies is the workflow. It does not touch the verdict, the exporter, the simulator or the map, and
it should not.

**Existing features that get better.**
- Flight History: search and compare across all flights of a design, not one at a time; Kibana dashboards of
  battery, altitude, GPS and EKF per design and per mission.
- Mission test: fleet statistics on the card ("passed 38 of 40 simulated runs; the two failures lost GPS on leg
  3"), from indexed results.
- The simulator assistant and the planned copilot: parameter and manual lookups from `semantic_text` over
  ArduPilot's docs (a corpus Moss could also hold; Elastic wins when it is large and needs analytics too).
- Building avoidance and routing: incidents aggregated by place, so the routing can learn where the brake fires.
- The explain-the-verdict idea (Bitdeer): grounded by retrieving the catalog notes and formula descriptions.
- Operations: daemon, SITL and configurator logs in one place (Elastic's home turf); not a demo feature, but it
  makes the two-engine system debuggable.

**New features it makes possible.**
- "Find the signal" agent: ask in words why the courier drifted on leg 3, get an answer built from ES|QL over
  the flight's EKF and GPS fields plus the parameter manual, with the query shown.
- Anomaly workflow: on every new flight, score battery sag, EKF variance, GPS dropouts and brake events against
  the design's history; flag outliers in the report and the History tab.
- Design-to-outcome analytics: which motor, propeller and pack choices correlate with simulated failures across
  the hangar; the first evidence-based feedback loop from flight back into design.
- Cross-flight comparison before printing: this design versus its predecessor on the same mission, side by side.
- Regulatory and maintenance signal later: for real vehicles, the same pipeline over real logs.

**Track fit.** Good. It uses the four things the brief lists (Serverless project, agent skills in Claude Code,
`semantic_text`, an agent and a workflow) on data that is genuinely ours and genuinely large, and the result is
a capability the product lacks. The demo is a live flight, then the agent answering a question about it.

**Needs.** An Elastic Cloud Serverless project (free trial, created a day or two before judging so it does not
lapse); the agent skills installed in Claude Code; an ingest process (Node, reading the daemon's unix socket via
`telemetry/subscribe` and `mavlink/history`, bulk-indexing) started by `dev.sh`; mappings for telemetry as time
series plus `semantic_text` indices for parameter docs, catalog notes and formula notes; an Agent Builder agent
with ES|QL tools; one Workflow in YAML for new-flight scoring; a Kibana dashboard per design; the fleet
statistics line in the mission card.

**Risks.** Workflows are a technical preview and may change. The default inference endpoint can differ across
deployment types; set `inference_id` explicitly. Telemetry volume is fine for a trial but rate-limit the ingest
to what the analytics need. The trial lasts 14 days, so timing matters. If Moss or Convex search is also chosen,
decide by corpus: in-process lookups for the voice path, Elastic for the large corpus and analytics.

**Decision:** chosen on 2026-10-25; built in `DroneX_live/src/elastic` and `DroneX_live/elastic`. Recommendation was: a strong, honest fit that no other track covers, with real product
value (the first flight-to-design feedback loop); enter it if a one-day ingest and agent build fits the plan.

Docs: elastic.co/docs/solutions/search/semantic-search/semantic-search-semantic-text · elastic.co/docs/explore-analyze/ai-features/agent-skills ·
elastic.co/search-labs/blog/agent-builder-elastic-ga · github.com/elastic/agent-skills

---

## Bright Data: unlock, find and fetch the datasheets

**Challenge:** Best use of Bright Data. 1st $1,500 in Bright Data credits and a $500 Amazon card; 2nd $1,000 and
$350; 3rd $500 and $250. No stated rule beyond using it.

**What it is.** Web data infrastructure rather than packaged scrapers: the Unlocker API (fetch a page past
anti-bot measures and CAPTCHAs, with proxies), the SERP API (search results from Google and others as JSON), the
Web Scraper API (ready-made scrapers for big sites), ready datasets priced per thousand records, and a hosted
MCP server so an agent (Claude Code, or our own) can search and fetch live. Every account gets 5,000 free credits
a month (about $7.50; one credit per request or record), pay as you go about $1.50 per thousand requests
after that, a $499 Scale tier above. Figures from Bright Data's docs and third-party reviews that disagree in
places; confirm on the pricing page.

**What we have today.** The same catalog gap described under Apify: 53 hand-entered records with source URLs,
8 of them Wayback captures because manufacturer pages vanish, many `null` fields, physics on static
coefficients. Buildings come from OpenStreetMap via Overpass. No live lookups anywhere in the product.

**Does it genuinely help?** Yes, in the same place Apify does, and as infrastructure rather than as a packaged
Actor. The honest division: the SERP API answers "where is the datasheet for the T-Motor MN4014 330KV" (the
manufacturer page, the retailer spec table, the thrust test PDF), the Unlocker fetches pages that block plain
requests, and our own parser turns them into a record with the quoted spec lines. The hosted MCP server lets
the Dispatch agent or the configurator's advisor do a live lookup during a conversation ("what does this motor
weigh, and where does that number come from"), which is a live use judges can see. It does not touch the
verdict, exporter, simulator or map.

**Existing features that get better.**
- Catalog completeness and source preservation, as under Apify: fill the nulls, cite the page, snapshot it.
- "Unknown says so" becomes "unknown, and here are the three pages we searched", which is more honest still.
- Bill of materials with live retailer prices and stock through the Unlocker on a schedule.
- Buildings: the Overpass cache is slow and shared; a Bright Data fetch is not the right tool for Overpass, but
  it is for the vendor and manufacturer sites. No change to the city data.
- Nothing in the app gets faster; lookups are seconds, run before or alongside the demo.

**New features it makes possible.**
- Live part lookup in the configurator: paste a name, the SERP API finds the pages, the Unlocker fetches them,
  the parser proposes a record, the verdict re-runs, all sourced. Same user-facing feature as the Apify Actor,
  different plumbing.
- Agent lookups through the MCP server: the Dispatch agent or copilot answers sourcing questions live.
- Price history and availability signals for the hangar ("this battery is out of stock at both vendors").
- Regulatory feeds (airspace advisories, NOTAMs) for the mission area where no clean API exists.

**Track fit.** Good for a credits prize if the live part lookup is shown; the prize is credits and gift cards,
not a product endorsement. The overlap with Apify is complete for our purpose: Apify is the packaged, published
Actor (and a Best Actor prize); Bright Data is the infrastructure underneath a scraper we write ourselves. Using
both is possible (SERP to discover, an Actor to parse) but doubles the plumbing for one feature.

**Needs.** A Bright Data account (free credits suffice for a demo); a server route in the configurator that
calls SERP then Unlocker and parses spec tables into the record schema; the review gate before anything enters
the catalog; optionally the MCP server wired into the agent.

**Risks.** Terms of service of the sites fetched; parsers break as pages change; data quality (two revisions of
the same part) makes the review gate mandatory; free credits are modest. The prize value is credits we would
only use if the sourcing pipeline becomes ongoing work.

**Decision:** undecided. Recommendation: pick one of Apify and Bright Data for the sourcing pipeline. Apify if
we want a published Actor and the Best Actor prize; Bright Data if we want the SERP discovery step and the agent
MCP lookups and are content with a credits prize.

Docs: docs.brightdata.com · docs.brightdata.com/general/account/billing-and-pricing/free-tier · brightdata.com/products/serp-api

---

## Mana.space: a build-tool track

**Challenge:** Use Mana meaningfully while building; in the submission say where Mana helped and link one or
two public Mana pages or chats (the app or prototypes built in Mana, the chats where Mana planned, wrote or
debugged code); in the demo show one moment where Mana changed what was built or how fast. Judged on meaningful
use of Mana (30%), usefulness (25%), originality (25%), execution (20%), plus up to 10 bonus points if the
project lives inside Mana as an app or agent a judge can open and use. "A small thing that works beats an
ambitious idea that only exists in slides."

**What it is.** From the brief: an AI workspace with shareable pages and chats, in which Mana plans, writes and
debugs code and in which apps and prototypes can be built and hosted, including agents a judge can open. We
could not verify this online: mana.space rendered an empty page to our fetch, and web search returned unrelated
products with the same name (an iPhone creation app at mana.am, a family organiser, a child-development
platform). Treat the description above as the sponsor's own words and confirm the product's capabilities,
models, limits and pricing hands-on before planning around it.

**What we have today.** The product so far has been built with Claude Code; the repo has no Mana artefacts.
There is no public page or chat to link.

**Does it genuinely help?** Not the product. Like the Cursor rule in the SpaceXAI track, this is a rule about
how the work is done and where it is shown, not about what the product can do. The one place it could add
something is the bonus: a DroneX app or agent living inside Mana, which is a distribution channel, not a
capability. Whether Mana speeds the build depends on the tool's quality, which we could not assess.

**Existing features that would change.** None in the product. The process changes: some part of the remaining
work (a self-contained piece is best, such as the `/dispatch` page, the copilot overlay, the metrics page or
the Apify parser) is planned, written and debugged in Mana, with the chats made public and linked, and one
"this changed what we built" moment rehearsed for the demo.

**New features it makes possible.** Only through the bonus: a "DroneX Advisor" app or agent inside Mana that
calls one HTTP route on the configurator (the physics verdict over a build, the mission matrix) so a judge can
type a build and get the verdict without opening DroneX; the same route the Fetch.ai fleet agents need. That is
the "small thing that works".

**Track fit.** Neutral to moderate. Thirty percent of the score is how Mana helped, so the entry is only as good
as the public chats we can show; the other seventy percent is the product, which stands on its own. The bonus
is cheap if the verdict route exists.

**Needs.** Access to Mana (the user has it; we do not) and a hands-on check of what it can build and host; a
decision on which piece of work to do inside Mana; public links to those pages and chats; the verdict HTTP route
for the in-Mana app; a rehearsed demo moment.

**Risks.** Unverified product; the work done in Mana must be real or the 30% reads as theatre; splitting the
build across Claude Code, Cursor (SpaceXAI) and Mana is friction, so do not enter all three process tracks.

**Decision:** undecided. Recommendation: enter only if the user, after trying Mana, finds it genuinely useful
for one self-contained piece; then do that piece in Mana and add the in-Mana advisor app for the bonus. Do not
combine with the Cursor requirement of SpaceXAI.

Docs: mana.space (unverified; sponsor brief as pasted)

---

## SpacetimeDB: a shared, persistent airspace

**Challenge:** "Spacetime as the core real-time backend, especially anything with live shared state,
multiplayer interaction, or instant sync between users, agents and systems": chat and community, collaborative
tools, AI agent coordination, live dashboards, shared simulations, multi-user planning. "Meaningfully used, not
just added on the side." SpacetimeDB is a presenting sponsor of Cal Hacks 13.0.

**What it is.** A database with the application logic inside it. Tables; reducers (transactional, atomic,
rolled back on failure, cannot reach outside); procedures (can make HTTP calls, manage their own transactions);
views (read-only, subscribable); schedule tables for timed reducers; HTTP handlers; client SDKs for TypeScript
(React, Next.js, Node and more), Rust, C# and C++ that subscribe with SQL and receive live row updates;
`spacetime start` for local development; Maincloud hosting with a free tier of 2,500 TeV a month (about 3
million function calls, 12.5 GB egress, about 1 GB of table storage, 5 databases per project, databases pause
after a week idle), Pro at $25. Version 2.0 at assessment time. Server module languages beyond Rust and C# were
not confirmed on the pages we read.

**What we have today.** Live state is per computer: the Rust daemon streams telemetry to its own UI over a
WebSocket, and the Node backend's relay lets one remote viewer watch one computer through a signed grant, with
watch links for a single flight. There is no shared world: two operators' drones do not know about each other,
no corridor or altitude rule is enforced across vehicles, the Dispatch agents (planned) have no common state,
and the configurator's designs are files on one disk.

**Does it genuinely help?** Yes, and it is the one backend track whose pitch maps onto a feature we actually
want rather than a relocation of what we have. The product's story ends with a drone flying over a real city;
a city has more than one drone. A shared, persistent airspace in Spacetime, with each daemon mirroring its
vehicles into tables through reducers, gives every operator and every agent one live picture, and the rules
live next to the data where they belong: corridor reservations, altitude bands, minimum separation, a
building-avoidance incident log, mission hand-offs. The Dispatch agents coordinate through the same tables (the
sponsor's own "AI systems coordinating in a persistent world state"). Against Convex, assessed earlier for the
same slot: Convex is stronger for files, durable workflows and auth; Spacetime is stronger for the many-to-many
live world and server-side rules, and it is the presenting sponsor. One of the two, not both.

**Existing features that get better.**
- The 3D map and fleet list: every vehicle in the shared airspace, not just this computer's, live.
- Building avoidance and routing: rules enforced for all vehicles in a reducer (reserve a corridor, refuse a
  conflicting one, warn on separation), instead of per-vehicle checks in one UI.
- Watch links and remote viewing: a subscription to the shared tables replaces the one-to-one relay for the
  viewing case (the relay stays for remote control, which needs the daemon).
- Fly in simulation: the vehicle is registered in the airspace with its design, so "whose drone is that and what
  is it rated for" is one query.
- The Dispatch agents (Fetch.ai plan): shared state for candidate selection, mission assignment and status,
  with transactional hand-offs.
- Nothing in physics, export or the SITL gets faster; the mirror adds a few hundred milliseconds of latency to
  what others see of your drone.

**New features it makes possible.**
- Multi-operator simulation: a clinic's two couriers, the fire department's scout and a student's quad in the
  same San Francisco at the same time, each on its own laptop, deconflicted by rules in the database.
- Airspace reservations and corridors: request a corridor and altitude band for a mission leg; the reducer
  grants or refuses atomically; the 3D map shows reserved corridors.
- Shared incident log and leaderboards for practice: who landed, who hit the brake, which routes fail; a
  persistent world the Get started guide can send a new pilot into.
- Agent coordination: several Dispatch agents bidding for missions and reserving corridors through the same
  tables, with a scheduled reducer expiring stale reservations.
- Spectator mode and live dashboards for judges: open a page, see every drone in the demo airspace move.

**Track fit.** Strong if the shared airspace is built with rules in reducers and at least two computers (or two
daemons on one machine) feeding it live; it is exactly the "shared simulation" and "AI agent coordination" the
sponsor lists, from the presenting sponsor. Weak if Spacetime only stores designs.

**Needs.** A Spacetime module (Rust fits the team; the daemon is Rust) with tables for vehicles, positions,
missions, corridors, incidents and agents, and reducers for the rules; a mirror process per computer reading the
daemon socket (`telemetry/subscribe`) and calling reducers at a few hertz; the configurator or copilot overlay
subscribing with the TypeScript SDK to draw the shared airspace (the simulation UI is a prebuilt bundle);
identity per operator; two vehicles live for the demo (two SITL instances on one laptop suffice).

**Risks.** Reducer call budget on the free tier (3 million a month) is ample at 2 to 5 Hz per vehicle but not
at full telemetry rate; mirror at the rate the airspace needs. Server modules in Rust or C# only, as far as we
confirmed. Two live-state paths (daemon WebSocket and Spacetime) need a clear boundary: the daemon owns
control, Spacetime owns the shared picture and rules. Overlaps Convex entirely for our purpose.

**Decision:** chosen on 2026-10-25 over Convex; being built in `DroneX_live/spacetime`. Recommendation was: if a backend track is entered, prefer Spacetime over Convex for the
shared airspace, and build the corridor-reservation rule as the demo moment: two drones ask for the same
corridor, one is refused and rerouted over the buildings.

Docs: spacetimedb.com/docs · spacetimedb.com/docs/functions · spacetimedb.com/pricing · github.com/clockworklabs/SpacetimeDB

---

## Combinations for a six-hour build (assessed 2026-10-25)

The user wants SpacetimeDB, Elastic, Fetch.ai and Cartesia with six hours available. Minimal, demoable versions
cost roughly: Fetch.ai Dispatch 2.5–3 h, Cartesia copilot 3 h, Spacetime airspace 3–3.5 h, Elastic ingest +
agent 2.5–3 h, Moss as a rider on Cartesia 1 h, Bitdeer as the Dispatcher's model 0.5 h, Microsoft metrics page +
RESPONSIBLE.md 1 h on top of Dispatch, Apify Actor 2.5 h, Bright Data route 1.5 h. All four asked for is about
12 hours of minimal work, so a six-hour plan picks two deep tracks plus cheap riders.

Shared plumbing that pays for several tracks, built first (about 1 h): a telemetry mirror process on the daemon
socket with pluggable sinks (Spacetime reducers, Elastic bulk, copilot callouts); a `fly-preset` route that
starts a stored design without a browser export (agents can fly); a verdict/catalog HTTP route (fleet agents,
Microsoft, Mana).

| Combination | Tracks covered | Hours | Pros | Cons |
|---|---|---|---|---|
| A. Fleet + agents | Spacetime, Fetch.ai, Microsoft ×2, Bitdeer | 6–6.5 | Presenting sponsor plus the agent story; shared airspace is the Dispatch agents' coordination state; mostly Python and Rust, no UI bundle patching; five prizes | No voice; Elastic dropped; depends on ASI:One/Agentverse being reachable at judging |
| B. Voice + fleet | Cartesia, Spacetime, Moss | 6.5 | Most visual live demo (speak, drone moves, second drone refused a corridor); one overlay page hosts both; Moss nearly free | No agent or data story; Fetch.ai plan unused; demo-hall noise risk |
| C. Data + fleet | Spacetime, Elastic | 5.5–6 | One mirror feeds both; strongest "backend" story; least external-platform risk | Only two prizes; less flashy; Elastic Workflows is a preview |
| D. Voice + agents | Cartesia, Fetch.ai, Moss, Bitdeer | 6.5–7 | Two strong tracks that share the intent model; copilot and dispatcher can share tools | Over budget; two external platforms (ASI:One, Cartesia) at once; no Spacetime (presenting sponsor) |
| E. All four, shallow | Fetch.ai, Cartesia, Spacetime, Elastic | 7+ with no buffer | Four sponsor boxes ticked | Each judged as a bolt-on; no slack for the first bug; judges reward the small thing that works |

Recommendation: A if the Fetch.ai plan matters most (it is the only one already planned in detail), B if the
demo should be felt rather than explained. Either way, the user should create accounts in parallel during the
first hour (Spacetime login, Elastic trial, Cartesia key, ASI:One key and Agentverse mailbox clicks), since those
are the only steps the user must do personally.
