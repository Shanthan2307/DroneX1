"""Writes ArduPilot's SITL frame table (Tools/autotest/pysim/vehicleinfo.py) as
the vehicleinfo.json Core reads beside a simulator build.

    python3 scripts/sitl-frame-table.py <ardupilot-checkout> <out.json>
"""

import json
import os
import sys

ardupilot, out = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(ardupilot, "Tools", "autotest"))
from pysim.vehicleinfo import VehicleInfo  # noqa: E402

with open(out, "w") as f:
    json.dump(VehicleInfo().options, f, indent=1, sort_keys=True)
print(f"wrote {out}")
