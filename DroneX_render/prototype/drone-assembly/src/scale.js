// Scene scale: scene units per metre. Every geometry is authored in metres and converted with SCALE once
// (parts.js piece/toUnits). A drone is additionally drawn at a display scale (droneLayout.js viewK) so it fills
// the view; see docs/drone-integration.md §2.
export const SCALE = 0.25;
