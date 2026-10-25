"use client";
// Placeholder: the SpacetimeDB track replaces this with the live shared-airspace view (subscriptions to the
// vehicles, positions and corridors tables; every drone and reserved corridor drawn live).
export default function AirspaceView() {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", color: "#9aa3b2", fontSize: 14 }}>
      Shared airspace (SpacetimeDB): connecting…
    </div>
  );
}
