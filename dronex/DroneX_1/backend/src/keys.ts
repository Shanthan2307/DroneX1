// Which vendor key each use gets. The browser keys (ARCGIS_KEY for the 2D
// basemap, GOOGLE_MAPS_KEY for 3D tiles) are handed to the page, so they are
// restricted by referrer at the provider. Place search calls Esri's geocoder
// from this server with no Referer, so a referrer-restricted key fails there:
// it takes ARCGIS_GEOCODE_KEY (restricted by API and the server's IP), and
// falls back to ARCGIS_KEY for local development, where one key does both.

export type KeyEnv = Record<string, string | undefined>;

const set = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Keys the page asks for at /v1/maps/key and /v1/maps/google-key. */
export function browserMapKeys(env: KeyEnv): { arcgis?: string; google?: string } {
  return { arcgis: set(env.ARCGIS_KEY), google: set(env.GOOGLE_MAPS_KEY) };
}

/** The key for server-side geocoding (/v1/places*): ARCGIS_GEOCODE_KEY, else ARCGIS_KEY. */
export function geocodeKey(env: KeyEnv): string | undefined {
  return set(env.ARCGIS_GEOCODE_KEY) ?? set(env.ARCGIS_KEY);
}
