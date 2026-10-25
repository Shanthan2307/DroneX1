"""DroneX Dispatch: Fetch.ai uAgents that turn a sentence in ASI:One into a verified, flying vehicle.

Three roles, three processes (run.py starts them all):

    ASI:One user ──chat protocol──▶ Dispatcher ──CapabilityQuery──▶ Fleet agents (one per hangar drone)
                                       │                                   │ verdict, readiness, mission matrix
                                       │◀──────────────────────────────────┘ (from the configurator's /api/catalog)
                                       │
                                       └──FlightOrder──▶ Flight agent ──HTTP──▶ configurator ──unix socket──▶ Core daemon
                                           ◀─progress─┘   (/api/sim/refly, /api/copilot/intent, /api/airspace)

Every number comes from the configurator's physics (dronePhysics.js over the dataset); the agents gather, compare
and act, they never compute a verdict themselves.
"""
