// Test-only shortcuts into a running match. These reach into a Game hosted inside the e2e
// process through startServer().rooms, so no player can ever touch them: nothing in public/ or
// server/ knows they exist, and there is no URL, message or key that leads here.
import { ACTOR, EV } from '../../public/shared/schema.js';

export const gameOf = (server, code) => server.rooms.get(code)?.game ?? null;

// Clears the field and opens the BUILD before wave n, the way finishing wave n-1 would.
export function jumpToWave(g, n) {
  for (const foe of g.foes()) g.despawn(foe);
  g.clearBalls();
  g.wave = n;
  g.openSiegeBuild(false);
}

export function boss(g) {
  for (const foe of g.foes()) if (foe.kind === ACTOR.TRUCK || foe.kind === ACTOR.STEVE) return foe;
  return null;
}

export function setBossHp(g, fraction) {
  const b = boss(g);
  if (b) b.hp = Math.max(1, b.maxHp * fraction);
  return b;
}

export function setColonelHp(g, team, hp) {
  const col = g.colonel(team);
  col.hp = hp;
  g.touchStruct(col);
}

// One pickup of a chosen kind, on a chosen spot, where a real drop would pick both at random.
export function placePickup(g, kind, x, y) {
  g.nextPickupId += 1;
  const p = { id: g.nextPickupId, kind, x, y, expiresAt: g.tick + 30 * 60 };
  g.pickups.set(p.id, p);
  g.emit({ e: EV.P_ADD, id: p.id, k: kind, x, y });
  return p;
}

// Keeps BUILD open for as long as a test needs it.
export function holdBuild(g, seconds) {
  g.endsAtTick = g.tick + seconds * 30;
}
