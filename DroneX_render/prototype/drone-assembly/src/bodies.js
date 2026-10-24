// Sky constants for the far layer (world.js) and the planet shader (planet.js): atmosphere per body from
// NASA's fact sheets, and the sun's direction per body (visual choices, not data).

// ---------- bodies: constants from NASA's planetary fact sheets ----------
// https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html, .../marsfact.html, .../earthfact.html
//   Moon: "GM (x 10^6 km^3/s^2) 0.00490", "Volumetric mean radius (km) 1737.4", "Surface gravity (m/s^2) 1.62",
//         "Surface pressure (night): 3 x 10^-15 bar".
//   Mars: "GM ... 0.042828", "Volumetric mean radius (km) 3389.5", "Surface gravity (mean) (m/s^2) 3.73",
//         "Surface pressure: 6.36 mb at mean radius (variable from 4.0 to 8.7 mb depending on season)",
//         "Surface density: ~0.016 +/- 0.006 kg/m3", "Scale height: 11.0 km".
//   Earth: "Surface pressure: 1014 mb", "Surface density: 1.217 kg/m3", "Scale height: 8.5 km".
const FACTS = {
  moon: { gm: 0.0049e15, radius_m: 1737.4e3, g: 1.62, source: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html" },
  mars: { gm: 0.042828e15, radius_m: 3389.5e3, g: 3.73, p0_Pa: 636, rho0: 0.016, H_m: 11.0e3, source: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html" },
  earth: { p0_Pa: 101400, rho0: 1.217, H_m: 8.5e3, source: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html" },
};

// Atmosphere constants for the planet shader (UI4). Moon: none.
export function atmosphereFor(body) {
  if (body === "moon") return { none: true, scaleHeight_m: null, surfacePressure_Pa: 0, surfaceDensity_kgm3: 0, colourHint: null, source: `${FACTS.moon.source} ("Surface pressure (night): 3 x 10^-15 bar": effectively none)` };
  const f = FACTS[body] ?? FACTS.earth;
  return {
    none: false,
    scaleHeight_m: f.H_m,
    surfacePressure_Pa: f.p0_Pa,
    surfaceDensity_kgm3: f.rho0,
    colourHint: body === "mars" ? "#d8a273" : "#6fa8ff", // visual hint only
    source: f.source,
    note: body === "mars" ? "NASA's fact sheet gives 6.36 mb (636 Pa) at mean radius, 4.0-8.7 mb by season; the often-quoted 610 Pa is not on it." : "Fact-sheet values; the ascent itself uses ISA sea level (101,325 Pa, 1.225 kg/m3).",
  };
}

// Sun and light per body for the ending scenes (visual choices, not data). sunDir is a unit vector in the site
// frame: +x east, +y up, +z south. Earth: dawn terminator over the site; Moon: low sun (12 deg) near the
// terminator (long shadows); Mars: mid-morning.
export function lightingFor(body) {
  const dir = (elev_deg, az_deg) => {
    const e = (elev_deg * Math.PI) / 180;
    const a = (az_deg * Math.PI) / 180; // from east, toward south
    return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)].map((v) => Math.round(v * 1e4) / 1e4);
  };
  if (body === "moon") return { body, sunDir: dir(12, 15), sunElevation_deg: 12, ambient: 0.02, skyColour: "#000000", note: "low sun near the terminator: long shadows, black sky (no air); 12 deg so the lander's shadow stays clear of crater shadows" };
  if (body === "mars") return { body, sunDir: dir(35, 25), sunElevation_deg: 35, ambient: 0.25, skyColour: "#c9a27a", note: "mid-morning, dusty butterscotch sky (hint)" };
  return { body: "earth", sunDir: dir(2, 0), sunElevation_deg: 2, ambient: 0.08, skyColour: "#0b0d12", limbGlowHint: "#e8a36a", note: "dawn terminator over the site" };
}
