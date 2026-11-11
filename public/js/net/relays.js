// TURN relays, for players whose networks refuse a direct browser-to-browser connection (mobile
// data, many routers, school and work networks). ICE tries direct paths first and only falls back
// to a relay when they fail, and the game's data stays encrypted end to end either way.
// Credentials come from the relay provider's dashboard. An empty list means direct connections only.
export const RELAY_ICE_SERVERS = Object.freeze([]);
