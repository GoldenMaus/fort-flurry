// TURN relays, for players whose networks refuse a direct browser-to-browser connection (mobile
// data, many routers, school and work networks). ICE tries direct paths first and only falls back
// to a relay when they fail, and the game's data stays encrypted end to end either way.
// Credentials come from the relay provider's dashboard. An empty list means direct connections only.
export const RELAY_ICE_SERVERS = Object.freeze([
  // ExpressTURN free plan. UDP first; TCP for networks that block UDP.
  {
    urls: ['turn:free.expressturn.com:3478', 'turn:free.expressturn.com:3478?transport=tcp'],
    username: '000000002109943715',
    credential: 'CIG75fpSNPuU+wzbXq75h7p1UrU=',
  },
]);
