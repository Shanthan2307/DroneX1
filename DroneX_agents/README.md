# DroneX Dispatch (Fetch.ai / ASI:One)

**A sentence in ASI:One becomes a verified, flying vehicle.** Tell the dispatcher the job ("deliver 500 g of
blood samples 6 km to UCSF within 20 minutes"); it asks the hangar which drone the physics says can do it,
shows you the verdict as a review card, and on your approval flies that drone in the ArduPilot simulator over a
real San Francisco, with the progress streamed back into the chat. When nothing passes, it names the failing
check and offers the one-part swap the configurator has re-judged as passing.

This is the third engine of DroneX, beside the rendering engine (`DroneX_render`, the configurator and the
physics) and the simulation engine (`dronex/DroneX_1`, the Core daemon and ArduPilot SITL). It never computes a
number: every verdict comes from `dronePhysics.js` over the sourced dataset, through the configurator's JSON
routes.

## Architecture

```
 ASI:One user
     │  Agent Chat Protocol + Interactive Cards (form → carousel → review → detail)
     ▼
 Dispatcher  (dronex_agents/dispatcher.py)  ── mailbox on Agentverse, discoverable in ASI:One
     │  CapabilityQuery / CapabilityReply (custom protocol, local)
     ├──▶ Fleet: 8 uAgents, one per hangar drone (dronex_agents/fleet.py)
     │       each answers from its own verdict, readiness and mission matrix (/api/catalog)
     │  FlightOrder / FlightProgress / FlightResult (custom protocol, local)
     └──▶ Flight agent (dronex_agents/flight.py)
             /api/sim/designs  → the stored, packed design of that hangar drone
             /api/sim/refly    → a new simulated vehicle (the daemon starts ArduPilot SITL)
             /api/sim/vehicles → waits for GPS fix + EKF good, then takeoff, place lookup, go-to
                                 (the copilot's tools run directly on Core RPC, no model in between)
             /api/airspace     → a corridor to the place from the SpacetimeDB reducer before the go-to
                                 (refused: it holds and says why), and the mission's status (optional track)
             Agent Payment Protocol (optional): quotes a per-flight price, the dispatcher commits
```

While a flight is on, what you say to the dispatcher ("return to launch", "what's the battery") goes to that
vehicle through the copilot (`/api/copilot/intent`); a new job sentence (a distance and a time) starts a new search.

Intent parsing uses the ASI:One model (`INTENT_API_KEY`); without a key a rule parser handles the demo
sentences. Everything else is code.

## Run

```sh
# once
uv venv --python python3.11 DroneX_agents/.venv
uv pip install --python DroneX_agents/.venv/bin/python -r DroneX_agents/requirements.txt
cp DroneX_render/.env.example DroneX_render/.env.local   # then fill in the keys (see below)

# the configurator and the simulation engine first (project root)
./dev.sh
# then the agents (fleet, flight, dispatcher; logs in DroneX_agents/logs/)
DroneX_agents/dev.sh
```

`DroneX_agents/dev.sh dispatcher` runs one agent in the foreground. `python scripts/live_chat.py "<sentence>"
"<preset id>" "approve"` talks to a running dispatcher from this machine the way ASI:One does.

## Pair with Agentverse and ASI:One (once)

1. Create an API key on Agentverse (Profile → API Keys) and put it in `DroneX_render/.env.local` as
   `AGENTVERSE_API_KEY`.
2. Start the agents (`DroneX_agents/dev.sh`), then connect the dispatcher's mailbox:
   `DroneX_agents/.venv/bin/python DroneX_agents/scripts/connect_agentverse.py`. It registers the name, the handle
   (`@dronex-dispatch`), the description and `readme/dispatcher.md` in one step. (Without a key: open the
   **Agent inspector** link from `logs/dispatcher.log`, **Connect → Mailbox**.)
3. Check: `connect_agentverse.py --status`, or the configurator's `http://localhost:3000/dispatch` page, which
   turns green at "Listed on Agentverse as DroneX Dispatch".
4. Test through ASI:One itself: `DroneX_agents/.venv/bin/python DroneX_agents/scripts/asi1_e2e.py`. It passes only
   if a message from ASI:One really reached the dispatcher (the model can describe a reply it never got), then try
   it by hand in the ASI:One chat: say "@dronex-dispatch help".

The fleet and the flight agent talk to the dispatcher locally (addresses derive from the seeds, see
`addresses.py`), so only the dispatcher needs a mailbox. To list them on Agentverse too, set
`DRONEX_FLEET_MAILBOX=1` / `DRONEX_FLIGHT_MAILBOX=1` and connect each the same way.

## Settings (DroneX_render/.env.local)

| Key | What |
|---|---|
| `INTENT_API_BASE`, `INTENT_API_KEY`, `INTENT_MODEL` | the ASI:One model (https://asi1.ai/dashboard/api-keys); any OpenAI-compatible endpoint works |
| `DRONEX_RENDER_URL` | the configurator, default `http://localhost:3000` |
| `DRONEX_DISPATCHER_SEED`, `DRONEX_FLEET_SEED`, `DRONEX_FLIGHT_SEED` | long random strings; they fix the agents' addresses |
| `AGENTVERSE_API_KEY` | connects the dispatcher's mailbox from the terminal (`scripts/connect_agentverse.py`) |
| `DRONEX_MAILBOX` | `1` (default) for the dispatcher's Agentverse mailbox; `0` for a local-only test |
| `DRONEX_PAYMENTS`, `DRONEX_PAYMENTS_LEDGER`, `DRONEX_FLIGHT_PRICE_FET` | the Payment Protocol bonus: quote a price per flight; with the ledger flag the dispatcher pays testnet FET on Dorado (fund its wallet from the faucet) and the flight agent checks the transaction on chain before flying |

## Before the demo

A hangar drone can only be flown by the agents after it has been packed once from the configurator: open
`http://localhost:3000/?build=<preset id>`, **Build all**, **Fly in simulation**. Pack the drones the demo will
ask for (`chimera7-longrange` for the 10 km ridge run, `vtbird-vtol-mapping` for the crop survey). The flight
agent says exactly this when a drone is missing.

## Tests

```sh
DroneX_agents/.venv/bin/python -m pytest
```

Card payload shapes against the documented schemas, card-response parsing (JSON and planner prose), request
parsing with a mocked model and the rule fallback, candidate ranking, swap search over a mocked `/api/verdict`,
the render API client over a mock transport, design picking, the flight sequence (pre-arm wait, takeoff retries,
corridor granted / refused / airspace off), fleet replies, deterministic addresses. No network.

## Files

```
dronex_agents/config.py      settings from .env.local; preset ids; seeds
dronex_agents/addresses.py   seed → address; LocalFirstResolver (local agents by rule, the world by Almanac)
dronex_agents/render_api.py  typed client for the configurator's routes
dronex_agents/cards.py       Interactive Cards builders and the answer parser
dronex_agents/mission.py     request parsing (model + rules), mission mapping, ranking, swap search, review rows
dronex_agents/protocol.py    CapabilityQuery/Reply, FlightOrder/Progress/Result, PaymentQuote
dronex_agents/dispatcher.py  the ASI:One agent and its conversation
dronex_agents/fleet.py       one agent per hangar drone, in a Bureau
dronex_agents/flight.py      the flight agent
dronex_agents/airspace.py    the shared airspace client (optional)
dronex_agents/payment.py     Agent Payment Protocol, seller and buyer sides
dronex_agents/llm.py         the ASI:One model call
dronex_agents/run.py         starts the three processes
readme/*.md                  Agentverse READMEs
scripts/live_chat.py         a local ASI:One stand-in
scripts/connect_agentverse.py  Connect → Mailbox from the terminal (AGENTVERSE_API_KEY); --status
scripts/asi1_e2e.py          ASI:One end to end, judged by the dispatcher's own log
tests/                       pytest
```
