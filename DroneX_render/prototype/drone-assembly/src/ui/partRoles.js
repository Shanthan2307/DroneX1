// What each kind of drone part does and why its numbers matter, in plain words for someone who has never built
// a drone. Wording only: no numbers live here (the numbers are on the card, from the records and the verdict).
//   partRole(kind) -> { label, does, why }   any kind, including ones this table has never heard of
//   PART_SLOT_ROLE[slot]                      the same words keyed by configurator slot (About view)

/** @typedef {{ label: string, does: string, why: string }} PartRole */

const MOTOR = {
  label: "motor",
  does: "Spins the propeller. Brushless: the outer bell turns around fixed copper windings.",
  why: "KV is rpm per volt: high KV spins small propellers fast, low KV turns big ones slowly and efficiently. Its weight counts once per arm.",
};
const PROPELLER = {
  label: "propeller",
  does: "Turns the motor's spin into thrust by throwing air.",
  why: "Diameter and pitch decide how much air it moves: bigger or steeper means more thrust, and more current from the pack.",
};

/** @type {Record<string, PartRole>} */
const ROLES = {
  "drone-frame": {
    label: "frame",
    does: "Holds everything together: the arms carry the motors, the plates sandwich the electronics and the battery.",
    why: "Its empty weight is weight every motor must lift; its size sets the largest propeller it can swing.",
  },
  "drone-arm": { ...MOTOR, label: "arm + motor", does: "The arm holds a motor out where its propeller has room; the motor spins it." },
  "drone-nose-motor": { ...MOTOR, does: "Pulls the plane forward through the air; the wing does the lifting." },
  "drone-propeller": PROPELLER,
  "drone-nose-propeller": { ...PROPELLER, does: "Pulls the plane forward. It only has to beat drag, not hold the weight up." },
  "drone-battery": {
    label: "battery",
    does: "Stores the energy for the whole flight and feeds every motor at once.",
    why: "Capacity and cell count set the energy, which sets flight time; its current rating says whether it can feed full throttle. Often the heaviest part.",
  },
  "drone-camera": {
    label: "payload",
    does: "What the drone is for: the camera, sensor or cargo it carries.",
    why: "Every gram of it is lift and flight time spent; a mission may need a particular one fitted.",
  },
  "drone-electronics": {
    label: "electronics",
    does: "Flight controller, motor controllers (ESCs), video transmitter and wiring: the brain and nerves.",
    why: "Not a choice here: its weight is the frame's stated figure or a documented allowance, marked est.",
  },
  "drone-fuselage": {
    label: "fuselage",
    does: "The body of the plane: carries the battery, electronics and payload, and joins wing and tail.",
    why: "Its empty weight is weight the wing must carry; a lighter airframe cruises slower and longer.",
  },
  "drone-wing": {
    label: "wing",
    does: "Makes the lift, so the motor only has to pull the plane along.",
    why: "Span and area set the wing loading: lower loading flies slower, gentler and longer on the same pack.",
  },
  "drone-tail": {
    label: "tail",
    does: "Keeps the plane pointing straight and level, and steers it.",
    why: "Drawn from layout proportions; its weight is inside the airframe's empty weight.",
  },
};

// A kind we have no words for (a part the 3D side added later): a readable name from the kind itself.
const humanKind = (kind) => String(kind ?? "part").replace(/^drone-/, "").replace(/[-_]+/g, " ").trim() || "part";

/** @param {string} kind @returns {PartRole} */
export function partRole(kind) {
  return (
    ROLES[kind] ?? {
      label: humanKind(kind),
      does: "Part of this drone's structure.",
      why: "No dataset record of its own: its weight is counted inside the airframe's.",
    }
  );
}

/** @type {Record<string, PartRole>} */
export const PART_SLOT_ROLE = {
  airframe: ROLES["drone-frame"],
  motor: MOTOR,
  propeller: PROPELLER,
  battery: ROLES["drone-battery"],
  payload: ROLES["drone-camera"],
};
