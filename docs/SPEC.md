# Fort Flurry — Game & Technical Specification (v2)

The single source of truth. `public/shared/schema.js` and `public/shared/constants.js` are the code
half of the contract: import names from them, never re-declare them. Where this file says a word in
`code font`, spell it exactly so. Several engineers build this in parallel from this file alone.

## 0. Ground rules

- **Original work.** Fort Flurry is an original game in the "build, then snowball fight" genre. Its
  name, characters, art, music, maps and text are all ours. All art is drawn by our own code and all
  audio is synthesized by our own code. No external image, font or sound files. System font stacks only.
- **Banned strings.** Never in any shipped file (UI text, barks, banners, bot names, code, comments,
  package.json): Snowbrawl, Snow Brawl, brawl, Blackeye, Snowpack, Snowcraft, Brian, snowplow, snow plow,
  snow day, Frosty, Olaf, Elsa, Sven, Bumble, Hobbes, Let It Go, build a snowman, Winter is coming.
  No snowplow exists in any form (vehicle, pickup, foe, decor). All jokes and barks are written fresh,
  never quoted from a film, show or song. `test/originality.test.mjs` does a case-insensitive whole-word
  scan of `public/` (excluding `public/vendor/`), `server/` and `package.json`, and fails on any hit.
- **No build step.** Plain ES modules, served as-is. No TypeScript, no bundler, no framework.
- **`public/` is the whole website.** It must work from any sub-path (e.g.
  `https://user.github.io/fort-flurry/`), so every URL and import is **relative**. `public/shared/` is
  imported by the browser and by Node (`server/` imports `../public/shared/...`).
- **`public/shared/` must not touch** `window`, `document`, `process`, `fs`, `Buffer`, timers, or
  `Date.now`/`Math.random` in simulation code. Randomness comes from the seeded `g.rng()`.
- **The project path contains spaces.** Quote paths in every shell command and script.
- Runtime deps: `ws` on the server, vendored `public/vendor/peerjs.min.js` in the browser. Nothing else.
- **Named exports only.** No default exports anywhere.
- Kid-friendly tone: nobody dies. Foes "give up", kids "freeze" and get thawed. Snow, jokes, cocoa.
- **Primary deployment is a static site with P2P multiplayer** (GitHub Pages). The Node server is the
  secondary path. P2P must be rock solid.

## 1. The game in one paragraph

It's the first big snowfall of winter, and the town has one tradition: whichever fort is still standing
at nightfall rules the block until spring. Your crew has built yours around **Colonel Carrot**, a giant
snowman in a bucket helmet, and rival crews from across town are marching in to knock him down. Each
round starts with a short **build phase**: spend Flakes on snow walls, spare coats, spoon flingers and
cocoa stands. Then comes the **fight**: throw, lob, dodge, pack more snow, thaw frozen friends, and
survive the wave. Between waves everyone picks an upgrade card. Beat wave 5's **Sno-Cone Truck** and
wave 10's **Abominable Steve** to hold the block. Friends can also fight each other in **Fort Face-Off**
(team vs team, knock down the other Colonel) or **Free-for-All**. A full run takes about 15 minutes.
Up to 8 kids. How to Play and the title screen must use this premise.

## 2. Modes

### 2.1 Siege (co-op, main mode, 1–8 kids including buddy bots)
- All kids on `TEAM.A`. Colonel Carrot stands at `map.fort`. Lose when his hp reaches 0.
- `waveCount` is 5 (Quick), 10 (Full) or 0 (Endless). Win by clearing the last wave.
- Colonel `mhp = BUILD[COLONEL].hp × (1 + SIEGE.colonelHpPerExtraPlayer × (weightedPlayers − 1))`.
  `weightedPlayers` = connected non-AFK humans + bots × `SIEGE.botPlayerWeight`, minimum 1, recomputed at
  each BUILD start, keeping the Colonel's hp fraction. `countMul = 1 + perExtraPlayerCount × (weightedPlayers − 1)`.
- Loop: `BUILD` (firstBuildTime / buildTime) → `FIGHT` (squads spawn on schedule; ends when none remain
  to spawn and no foes remain) → award `waveBonusBase + waveBonusPerWave × wave` Flakes, heal Colonel 15%
  of max, thaw all frozen kids, offer cards → `BUILD`.
- Ready: `CMD.READY` toggles. If all humans are Ready, the phase ends now and the team gets
  `floor(secondsLeft × SIEGE.readyBonusPerSec)` Flakes. Ready also ends BUILD in Face-Off and FFA, with no
  bonus. AFK humans and late joiners with no body are not counted.
- Every kid refills to `maxBalls` when FIGHT starts.
- Frozen kids auto-thaw after `KID.frozenAutoThaw` s, or sooner if a friend stands within `KID.thawRange`
  for `KID.thawTime` s cumulative (a Cocoa Stand in range doubles speed). If no teammate, human or bot, is
  unfrozen, each frozen kid's remaining auto-thaw is capped at `KID.loneAutoThaw`. After any thaw or
  respawn a kid has `AFLAG.GRACE` for `KID.thawGrace` s: balls pass through and foes ignore them. GRACE
  ends early if the kid throws. A wipe does not end the game; only the Colonel falling does.
- `dayT` runs 0→1 across the run: dawn, noon, golden hour, night. Endless cycles.

### 2.2 Fort Face-Off (id `fortwars`; PvP teams, 2–8 kids including bots)
- `TEAM.A` vs `TEAM.B`, labels from `TEAM_NAME`. Colonels at `map.forts[team]`,
  `mhp = FORTWARS.colonelHp + FORTWARS.colonelHpPerExtraKid × (largest team size − 1)`.
- Round: `BUILD` 40 s with a **Truce Rope** across the map centre (kids cannot cross; building is own-half
  only in both phases; THROW and LOB are ignored during BUILD, packing still works) → `FIGHT` up to 240 s.
  A Colonel at 0 hp ends the round. From `suddenDeathAt`, both Colonels drain
  `suddenDeathPerSec × mhp / colonelHp` hp/s, so an untouched Colonel falls before the timer. If both reach
  0 on one tick, or hp fractions tie at the timer: the team that dealt more Colonel damage wins, then more
  freezes, then `g.rng()`. A round never replays. First to `roundsToWin`.
- Flakes: per-team pool. `flakePerSec` trickle during FIGHT, `flakesPerFreeze` per freeze.
- Frozen kids respawn at home after `respawnTime` unless thawed first. Neutral pickups drop on the
  centre line every `pickupEvery` s. Structures and Flakes reset each round. Kids reset at round start.

### 2.3 Free-for-All (2–8 kids including bots)
- Every kid has its own team id. No Colonel. Short BUILD (kids scatter, personal Flakes; throws ignored),
  then FIGHT. First to `freezesToWin` or most freezes at `matchTime`. Respawn after `respawnTime` at the
  `spawns.ffa` point farthest from the nearest enemy, with GRACE. `meta.leaderId` is the strict leader or
  null; freezing a leader who leads by `leaderBonusLead` or more counts as 2 freezes, and the renderer draws
  a paper crown on them. Ties: more hits landed, then a shared win.

### 2.4 Classic (id `classic`; PvP knockout duels, 2–8 kids including bots)
- `TEAM.A` vs `TEAM.B` with the Face-Off team picker (`TEAM_MODES`); Start needs a kid on each team. Played only on the Corner Lot (`ARENAS`, `modes:['classic']`), which no other mode offers; `sanitizeSettings` keeps mode and map in step through `mapsForMode`.
- Round: `BUILD` for `CLASSIC.buildTime` (8 s) with the truce rope (own half only, throws ignored). Each kid may own `CLASSIC.itemsPerKid` (3) structs at once from `CLASSIC.tools` (Snow Wall, Spare Coat, Spoon Flinger, at most `pultsPerKid` flinger), for free. `canPlace` counts structs with `ownerId === q.me`, so demolishing your own in BUILD gives the placement back. No Flakes, cards, repair, patch, or building in FIGHT; bots place their own three.
- `FIGHT` lasts up to `CLASSIC.roundTime` (75 s) with no Colonel. Each kid has `CLASSIC.hits` (3) hearts: any enemy hit costs one, an Iceball `iceHits` (2). Warmth mirrors hearts (`hp = maxHp × hearts / hits`) with no regen; a kid at 0 is knocked out for the round (frozen, no thaw, no respawn). A kid who joins mid-round starts knocked out.
- A team with no kid standing loses the round. At the timeout the team with more hearts left wins. Both wiped at once, or equal hearts at the timeout, goes to more hits that round, then `g.rng()`. First to `roundsToWin` (3); `ROUND_END` lasts `roundEndTime`.
- From round 2, kid speed and throw speed scale by `speedUpPerRound^(round−1)`, capped at `maxSpeedUp`. Meta `speedMul` carries it, and the client folds it into the predicted kid's mods.
- One Iceball (`PICKUP.ICE`) appears at `map.pickupSpot` every `pickupEvery` s of FIGHT when none is on the field.
- `PROTOCOL_VERSION` is 2 from this mode on.
- Look: Classic is drawn as original pixel art (`render/retro.js`): the world is painted at one pixel per two world units into a small canvas and scaled up without smoothing, with pixel hearts and KO over each kid. Name tags, aiming aids, the build preview and the HUD stay sharp, and the HUD takes a square, monospaced retro style (`#hud.retro`).

## 3. Core mechanics (numbers are in constants.js)

- **Motion:** acceleration + drag. On ice: low accel, low drag, cannot pack snow.
- **Packing:** standing still (no move input, speed < 20) on snow for `packDelay` starts packing one ball
  every `packTime × mods.packTimeMul` up to the cap. There is no reload key. `AFLAG.PACKING`, kid crouches.
  Charging or throwing interrupts it.
- **Direct throw:** hold THROW to charge (`AFLAG.CHARGING`, walks slower), release to throw toward `aim`.
  Power interpolates `THROW.quick`→`THROW.power` over `chargeTime`; charge ≥ 0.98 makes `BALL.POWER`.
  Costs 1 ball. Launch math in §7. Blocked by solid structures (when z < height) and `blocksBalls` obstacles.
  `BTN.CANCEL` clears a charge or lob with no throw and no cost.
- **Lob:** hold LOB (`AFLAG.LOBAIM`), aim at a ground point `(tx,ty)` (clamped to `maxRange`), release. Costs
  `lob.cost` balls. Arcs over walls and kids, lands exactly on target, splash damages enemy actors and
  structures in `splash × mods.lobSplashMul`. Client shows a landing reticle.
- **Belly slide:** SLIDE press: `slideSpeed` along move direction (aim if still) for `slideTime`. Immune to
  flat balls while sliding, still hit by splash. Cooldown `slideCooldown × mods.slideCdMul`.
- **Warmth = hp.** Regen `regenPerSec × mods.regenMul` after `regenDelay` s since last hit. Frozen at 0.
- **Hits:** knockback along ball velocity, brief flash. No friendly fire, balls pass through friends.
- **Specials:** a pickup replaces the current special. Next `uses` direct throws use it. Cocoa heals instantly.
  Board grants `boardTime` of speed.
- **Flakes (❄):** team build currency. Awarded instantly on a foe's defeat, no ground entity. Kill Flakes in
  Siege are × `1 / sqrt(countMul)` and accumulate as floats (`g.flakes[team]`); meta floors them. Wave bonus
  and `mods.flakeBonus` are unscaled.
- **Building:** select a tool, target a cell. `canPlace` in §10 is the one validity rule. Allowed in BUILD and
  FIGHT. Any kid may repair any structure of their team (same tool on a damaged one) to full for
  `ceil(REPAIR_COST_MUL × cost)`. During BUILD the Snow Wall tool on a hurt Colonel's cell **patches** him:
  `+colonelPatch.pct` of mhp for `colonelPatch.cost`, at most `colonelPatch.perBuild` per BUILD. A healthy
  Colonel can't be patched, so his cells are simply `badCell` and his sprite doesn't claim the click.
- **Demolish:** refused on the Colonel (`badCell`). Refund `floor(DEMOLISH_REFUND × cost × hp fraction)`,
  allowed if `ownerId` is that kid, or the owner has left or is AFK. A kid may also demolish a teammate's
  structure within `TEAMMATE_DEMOLISH_RANGE` of them, no refund, with a `TEAMMATE_DEMOLISH_COOLDOWN` s
  per-kid cooldown, so nobody can be walled in.
- **Spoon Flinger limit:** per team, `limit.base + limit.perPlayer × ceil(weightedPlayers on that team)` (FFA: 1
  per kid). They aim at target position + target velocity × flight time.
- **Cocoa Stands do not stack:** a kid in range of several gets `healPerSec` and `thawMul` once.
- **Fair share:** only with `FAIR_SHARE.minHumans`+ humans on a team. When BUILD or FIGHT starts each human
  gets `spendLeft = max(minFlakes, ceil(poolMul × pool / humans))`; each build or repair subtracts its cost;
  over budget is denied with `limit`. Otherwise `spendLeft` is unlimited. Bots on a team with a human spend
  only on repairs, at most 25% of the pool per phase. A bots-only team builds a simple ring plus flingers.
- **Cards:** at the start of each Siege BUILD except the first, each human gets 3 random cards; choosing is
  non-blocking. Unchosen offers auto-pick randomly when the phase ends. `game.js` picks for bots.
- **Foes defeated:** `AFLAG.FLEEING`, run to the nearest map edge with a white flag, despawn. A fleeing foe is
  harmless and can't be hit. Exception: a Carrot Thief carrying the nose is **not** FLEEING (see §5).

## 4. Cards (`public/shared/cards.js`)

`defaultMods()` returns `{speedMul:1, throwDmgMul:1, throwSpeedMul:1, maxBalls:0, packTimeMul:1, maxWarmth:0,
lobSplashMul:1, thawTimeMul:1, slideCdMul:1, buildRangeMul:1, regenMul:1, pultDmgMul:1, wallHpMul:1, flakeBonus:0}`.
The sim must honor every key. Every `*Mul` key multiplies (`mods.x *= v`); every other key adds. A kid may hold
one card at most 3 times, and offers never include a card held 3 times. `modsFromCards` clamps
`packTimeMul ≥ 0.4`, `slideCdMul ≥ 0.45`, `thawTimeMul ≥ 0.3`.

Exports: `CARDS = [{id, name, blurb, apply(mods)}]` (id a short string, only ids travel on the wire);
`CARD_BY_ID`; `defaultMods()`; `rollCards(rng, ownedIds, n=3)` → n distinct ids; `modsFromCards(ids)` → mods.
**The sim sets `kid.cards` (array of ids) and `kid.mods = modsFromCards(kid.cards)`; the client derives the same
object from `meta.cards[me]`, so both hold identical floats.** After a card, game.js re-derives `maxBalls` and `maxHp`.

At least 14 cards: Fuzzy Earmuffs (+25 max warmth), Good Boots (+12% speed), Snowball Tongs (−25% pack time), Big
Mittens (+3 ball capacity), Ice Core (+20% throw dmg), Fastball (+15% throw speed and range), Big Splat (+30% lob
splash), Hair Dryer (−40% thaw time), Greased Belly (−35% slide cooldown), Long Arms (+30% build range), Second
Sweater (+60% regen), Spring Spoon (+30% Spoon Flinger dmg, team-wide while its owner plays), Packed Tight (+25% wall
hp on walls you build), Lucky Mitten (+1 Flake per foe you defeat).

## 5. Foes, bosses, waves

`FOES` holds the stats. **Targeting**, re-evaluated every 0.5 s, first match wins (Thief, Sledder and bosses keep
their own behavior): (1) a kid who hit this foe in the last 3 s: walk toward them until in range; (2) nearest
unfrozen kid within 220; (3) a Spare Coat within `aggroRange`, rolled once per foe per coat at `aggroChance`;
(4) `dirAt().blocker`; (5) the Colonel. Foes never target FROZEN or GRACE kids.

**Blocked and stuck:** every walking foe reads `dirAt(x,y)`. If `blocker` is non-null it stops and attacks that
struct with its normal attack until it falls: Pipsqueak, Slinger, Lid Kid and on-foot Sledder throw flat, Lobber lobs,
Big Kid shoves. Stuck rule, all foes: if a walking foe moved under 12 units in the last 3 s and is not attacking,
it hops to the centre of the next flow cell, ignoring collision.

**Flat throw by foes:** `flight = min(range + 60, dist + 40) / ballSpeed`.

- **Pipsqueak:** walks the flow field, stops at range with LOS, throws with a little spread.
- **Slinger:** keeps long range, accurate, leads moving targets a little.
- **Lobber:** stays far, lobs at structures, Colonel, clusters. Clients show the landing spot.
- **Big Kid:** follows the flow field, ignores kids unless one is within range, shoves walls (melee `dmg` per `cd` to a
  struct), knocks kids back, tanky.
- **Sledder:** picks a lane, drives straight (`AFLAG.SLEDDING`), crashes into the first solid: `dmg` to it, clears
  SLEDDING, keeps kind SLEDDER and fights on foot with the `foot*` stats. Against a kid: `kidDmg` and `kidStun` s of
  STUNNED, and the sled keeps going.
- **Lid Kid:** dented trash-lid shield blocks flat balls in a frontal `shieldArc` (`AFLAG.SHIELDED`). It faces its target
  turning at most `turnRate` rad/s, so a kid can out-turn it inside about 200 units. Lobs and splash bypass it.
- **Carrot Thief (`SNEAK`):** white-clad, ignores kids, runs to the Colonel and vaults structures
  (`g.moveActor(a,dx,dy,{vault:true})`: ignores struct collision at 0.6× speed over a solid cell, so only kids can stop it).
  Grabs a carrot (the Colonel keeps spares in his bucket), sets `aux & AUX.NOSE`, stays hittable, runs to the nearest
  map edge at normal speed. Freezing it awards its Flakes and no hp is lost. If it reaches the edge, the Colonel loses
  `stealPct × mhp / countMul` hp, it despawns with no Flakes, and he shouts about it. Renderer hides his nose while any
  carrier lives.
- **The Sno-Cone Truck (boss, wave 5):** drives a loop on `map.truckPath`, playing its chime. Roof turret fires a 3-ball
  `CONE` volley every `cd` at the nearest unfrozen kid in `range`, else the nearest struct in range. Every `parkEvery` s
  it parks for `parkTime`, opens its doors (`aux & AUX.DOORS`, `takeDmgMul = parkDmgMul`), and `round(doorSquad × countMul)`
  Pipsqueaks hop out (0 Flakes). Crushes structures in its path. On defeat it drives off the map edge.
- **Abominable Steve (boss, wave 10):** a big fellow having a very bad day. Walks until `stopDist` from the Colonel. Every `cd`:
  POUND if any kid or struct is within `poundRadius` (telegraph `poundTelegraph` with `aux & AUX.POUND`; `dmg` to all kids and
  structs in radius, `quake` amt 1), else BOULDER at the nearest kid or struct; every third attack is a BOULDER. BOULDER (rolls,
  grows from `boulderR0` to `boulderR1` over `boulderLife`) deals `dmg` to kids and `dmg × boulderStructMul` to each struct
  touched. Below `enrageAt` hp: `AFLAG.ENRAGED`, speed and cd multipliers, and sets `g.blizzard = true`. Escort every `escortEvery` s:
  3 Pipsqueaks + 1 Slinger × countMul, 0 Flakes. Defeat: he sits down, gets a cup of cocoa, everyone cheers.

**Waves** (`public/shared/waves.js`, table `WAVES` and names `WAVE_NAMES` in constants.js):
`count = max(1, round(base × DIFF.count × countMul))`. Squads of 3–6 foes, one entrance each, evenly spaced across `win`, first
at +2 s; wave 1's first squad is 2 Pipsqueaks. Waves 1–4 use `min(2, entrances.length)` entrances; later waves use all.
Quick mode: wave 5 is the finale. Endless n > 10: `n%10==5` Truck, `n%10==0` Steve, boss hp × `(1 + 0.3 × floor((n−1)/10))`; other
waves use wave 9's mix × `1.12^(n−9)` with foe hp × `1.03^(n−9)`.

`new WaveRunner(g, n)` is constructed when BUILD starts and rolls squads and entrances with `g.rng()` in its constructor. `.update()`
runs only in FIGHT. `.done` = everything spawned. `.remaining` = not yet spawned. `.preview = {foes:[{k,n}], from:[entranceIdx]}`
goes into `meta.next`; the HUD shows foe icons with counts and the renderer draws an arrow at each `from` entrance during BUILD.
`waveInfo(n, waveCount)` → `{name, sub, boss}`, `boss` being `ACTOR.TRUCK`, `ACTOR.STEVE` or null. Respect `MAX_ACTORS` by queueing.

**Wave end guarantees:** `CMD.BUILD` is denied (`badCell`) within `SIEGE.entranceNoBuild` of any entrance. For `foeSpawnGrace` s
after spawning a foe has GRACE (can't be hit, doesn't act). If non-boss foes remain `waveOvertime` s after `.done` on a non-boss wave,
banner 'Lunchtime!', they all go FLEEING with no Flakes, and the wave counts as cleared. When a boss falls its escorts flee too.
When `foesLeft ≤ 3` the renderer shows edge arrows to them.

## 6. Maps (`public/shared/maps.js`)

Exports `MAPS = [court, pond, yard]` (array, menu order) and `getMap(id)` (returns MAPS[0] if unknown). `map.id === map.theme`, so
mapId is `'court'|'pond'|'yard'`. Default settings: `{mode:MODE.SIEGE, mapId:'court', difficulty:DIFFICULTY.NORMAL, waveCount:10}`.
```js
{
  id, name, blurb, theme,
  w, h,                          // multiples of CELL, around 1600x1200 to 2000x1400
  obstacles: [                   // shape rect {x,y,w,h} (top-left) or circle {x,y,r}
    { type: 'house'|'tree'|'pine'|'car'|'fence'|'lamp'|'rock'|'bench'|'swing'|'slide'|'bush'|'mailbox'|'hydrant'|'monkeybars'|'bin'|'schoolwall',
      shape, x, y, w, h, r, blocksMove: true, blocksBalls: true, height: 60, rot: 0, variant: 0 }
  ],
  ice: [ {shape:'ellipse', x, y, rx, ry} | {shape:'rect', x, y, w, h} ],
  fort: {x, y},                  // Siege Colonel centre, on a cell corner so his 2x2 cells are on the grid
  forts: [{x,y},{x,y}],          // Face-Off Colonels
  truce: {axis:'x'|'y', at: n},  // axis 'x' = the rope is the line x = at. A team's half is the side holding forts[team]
  spawns: { siege:[...], fortwars:[[...],[...]], ffa:[...] }, // every list has at least 8 points ({x,y})
  entrances: [{x,y}...],         // Siege foe entry points on the map edge
  truckPath: [{x,y}...],         // closed loop, clear of obstacles
  lights: [{x,y,r,color}...],    // lamp posts, house windows; used at dusk/night
  decor: [...],
}
```
`rot` is cosmetic, 0 or 90 only; physics ignores it and authored `w,h` are the final footprint. Decor types:
`{type:'road'|'path', points:[{x,y}...], width}`; `{type:'bridge'|'snowpatch', x, y, w, h}`;
`{type:'sled'|'shovel'|'reeds'|'drift'|'hopscotch'|'tiretracks', x, y, scale?}`. All decor is flat art baked into the ground cache
and never y-sorted. Anything with visible height is an obstacle, with `blocksMove:false` if kids may pass. Renderer fallback: an
unknown obstacle type draws a rounded snow-capped block from its shape and height; unknown decor is skipped; neither throws.

1. **Maple Court** (`court`): a cul-de-sac. Houses around the edge, parked cars, lamp posts, mailboxes, three street entrances. Open
   and friendly, the default.
2. **Wobble Pond** (`pond`): fort on an island in a frozen pond. Ice all around (slippery, no packing), pines and rocks on the banks.
   Foes skate in from all sides. Snow bridges give packing spots.
3. **Recess Yard** (`yard`): schoolyard. Chain-link fences block movement but **not** balls (`blocksBalls:false`), monkey bars, slide,
   swings, benches, a long `schoolwall` on one side.

## 7. Simulation API (`public/shared/game.js`)

```js
const g = new Game({ mode, mapId, difficulty, waveCount, seed, players: [{ id, name, look, team, isBot }] });
g.queueInput(playerId, frame)   // frame {seq, mx, my, aim, btn, tx, ty}; append only; ignores seq <= last queued seq
g.command(playerId, cmd)        // {c:CMD.*, ...}; validates; may emit EV.DENY
g.step()                        // advance exactly one tick
g.drainEvents()                 // -> Event[]; clears the queue; coalesces sHp to one per dirty struct
g.actorsForSnapshot()           // -> Actor records (hp 0..1 float, aim radians, aux 0..255); protocol.js quantizes
g.privateState(playerId)        // -> You record, or null when the player has no kid yet
g.ackSeq(playerId)              // -> last input seq applied or dropped; 0 when no kid
g.fullState(playerId)           // -> {tick, structs, pickups, balls, meta, offer}; JSON-safe
g.meta()                        // -> Meta, JSON-safe
g.setAfk(playerId, bool)        // disconnected kid stands idle
g.resetInput(playerId)          // empties the queue; ackSeq=0, last seq=0, credit=1. A new connection restarts seq at 1
g.addPlayer(p) / g.removePlayer(id)
g.isOver() ; g.result()
```
**Ids.** Player ids are integers 1..999, allocated by Room (lowest free, bots included, kept across reconnect). **A kid's actor id IS
its player id.** Game takes it from `players[].id`. Foes and structs draw from one Game counter 1000..65535: `next = next >= 65535 ?
1000 : next + 1`, repeated while live. Ball ids are a plain incrementing number, separate. Id 0 means nobody (`thaw.by`, `hit.by`, Colonel
`ownerId`). `conn.id` is host-private and never on the wire. So WELCOME.you = session.me = `to` = `ownerId` = `scores[].id` =
`result.players[].id` = view.players key = actor id. `view.me` is the actor with `id === session.me`, null if absent.
**Teams.** Room resolves team before `new Game`/`g.addPlayer`: Siege `TEAM.A`; Face-Off lobby pick or auto-balance; FFA `TEAM.FFA_BASE + slot`,
slot = lowest free 0..7. Game never rewrites it.

**`g.step()` order:** (1) `tick++`, `time += dt`. (2) Input (below). (3) Kid systems: thaw, regen, frozen timers, cocoa, pickups, derive
SLIDING/BOARDING/SLOWED/STUNNED/LOCKED flags from timers and phase. (4) Foe dispatch. (5) `WaveRunner.update()` in FIGHT. (6) Structures. (7)
Advance balls spawned before this tick; resolve hits. (8) Timers and phase changes. Events stamp `t = g.tick` (after the increment), the
snapshot taken next carries that same tick, and a `ball` event's x,y,z,vx,vy,vz are its state at tick t. Events raised between ticks by
`g.command` or `g.addPlayer` stamp `t = g.tick + 1`, the tick they will really be delivered with, because a client whose FULL was taken at
`g.tick` drops anything with `t <= FULL.tick`. Constructor events are t=0 and the opening banner is t=1, so it survives a FULL at tick 0.

**Input rule**, per human kid, at step 2: (a) `credit = min(credit + 1, MAX_INPUT_BACKLOG)`. (b) If `queue.length > MAX_INPUT_BACKLOG`, drop
oldest until 2 remain. If `queue.length > 2` on 30 consecutive ticks, drop the oldest one. A dropped frame ORs its btn into the next frame and
sets ackSeq to its seq, so no press or release is lost. (c) While the queue has frames and `credit >= 1`: `applyFrame(kid, frame)`, `credit -= 1`,
`ackSeq = frame.seq`. (d) If no frame was applied for more than 6 consecutive ticks, apply a neutral frame `{mx:0, my:0, btn:BTN.CANCEL}` with last
aim, tx, ty, leaving ackSeq unchanged. Before that a starved kid simply waits. **Never repeat a frame.** After 5 s with no frames set `AFLAG.AFK`
until frames return. `applyFrame` = `stepKidMotion(kid, frame, g.cw, DT)`, then charge, throw, lob and pack logic. Press and release come from an armed
state rather than raw `prev` edges, so a button held through a thaw or the end of the truce starts charging and a cancelled charge
can't revive until the button is let go; Session's prediction mirrors it with `p.armed`. It runs in every kid state and phase, so ackSeq always advances. Bots call `applyFrame` once per tick with `botFrame()`;
its seq is ignored. A kid with no body yet (Siege late joiner) ignores input.

**Sim actor** (objects in `g.actors`, created by game.js): `{id,kind,team,x,y,vx,vy,r,aim,hp,maxHp,speed,dmg,cd,flags,aux,stunT,slowT,takeDmgMul,ai}`.
For kids hp/maxHp are warmth. `ai` is `{}` scratch owned by the AI module. `takeDmgMul` defaults to 1. AI writes only aim, flags, aux, ai, takeDmgMul,
and moves only through `g.moveActor`. Kids add `{isBot,balls,maxBalls,special,specialN,charge,throwCd,slideT,slideCd,boardT,packT,prevBtn,cards,mods,spendLeft,stats}`.
`stats` = `{hits,freezes,thaws,built,flakes}`. Pickups are `{id,kind,x,y}`. Structs `{id,kind,cx,cy,team,hp,maxHp,ownerId}`; the Colonel is 2×2, `cx,cy` its
top-left cell. Balls `{id,kind,by,team,x,y,z,vx,vy,vz,g,t0,r,grow,rMax,dmg,seq,lx,ly,ft}`.

Foes also carry `lastHitBy` and `lastHitAt` (seconds), which targeting rule (1) reads. Structs also carry centre `x,y` and `cd`. `kid.special` is null when empty while You.special is 255. The stuck rule's hop is the one place AI writes `x,y` directly, since `g.moveActor` can't pass obstacles.

**Internals used by the AI modules** (must exist with exactly these names):
```js
g.tick; g.dt; g.time; g.rng(); g.map; g.cw; g.mode; g.phase; g.wave; g.difficulty; g.waveCount; g.blizzard; g.flakes;
g.countMul; g.actors /*Map*/; g.structs /*Map*/; g.balls /*Map*/; g.pickups /*Map*/;
g.foes() /*iterable of non-kid actors*/; g.kids() /*iterable of kids*/; g.weightedPlayers();
g.colonel(team) /*struct or null*/; g.structAt(cx,cy) /*struct or null, knows all 4 Colonel cells*/;
g.flow(moverTeam) /*FlowField: TEAM.FOES -> Siege Colonel, TEAM.A/B -> enemy Colonel, null in FFA*/;
g.spawnFoe(kind, x, y, opts) -> actor|null;  // opts {hpMul, noFlakes}. Fills r,speed,cd from FOES and hp,maxHp,dmg with DIFF and perExtraPlayerHp (or perExtraPlayerBossHp) already applied. Null at MAX_ACTORS, except bosses. Sets GRACE for foeSpawnGrace.
g.throwFlat(actor, angle, {speed, flight, dmg, kind, r, grow, rMax, life, seq, z0, splash, slow, stun, pierce, structMul, quiet});
g.throwLob(actor, tx, ty, {dmg, splash, kind, flight, seq});
g.damageActor(target, amt, sourceActor|null, {kx, ky, kind=-1, stun, slow, noAggro}) -> dealt; // kx,ky velocity in units/s added to target; amt × target.takeDmgMul
g.damageStruct(struct, amt, sourceActor|null);
g.freezeOrFlee(actor, source);  // kid: freeze. foe: sets FLEEING, awards Flakes unless noFlakes
g.despawn(actor);
g.nearestEnemy(actor, range);   // actors only, enemies of actor.team; skips FLEEING, FROZEN and GRACE
g.enemiesInRadius(team, x, y, r); // skips FLEEING and GRACE
g.los(x0,y0,x1,y1) -> bool;     // flat-throw line of sight
g.moveActor(actor, dx, dy, {vault}) -> blockingStruct|null; // dx,dy = this tick's displacement (speed*dt); applies SLOWED and Slick; updates x,y,vx,vy. Returns the struct only when the move lost at least half its distance, so a foe scraping past a wall isn't told to stop and attack it
g.bark(actorOrStruct, text); g.emit(ev); g.banner(text, sub, kind); g.sfx(name, x, y); g.awardFlakes(team, amt, x, y);
```
**Dispatch** (game.js, per foe per tick): GRACE: count down, no AI. STUNNED: count down stunT, no AI. FLEEING non-boss: game.js runs it to the nearest edge and
despawns it, no AI call. Otherwise TRUCK → `updateTruck`, STEVE → `updateSteve`, others → `updateFoe`; ai_foes never dispatches bosses. Boss AI is also called
while FLEEING and owns its exit (Truck drives off, Steve sits, then `g.despawn`). game.js does the SHIELDED arc test against the target's `aim` (`why:'shield'`) and the
FLEEING/GRACE no-hit rules. Decoy aggro is done in AI by scanning `g.structs`. game.js picks bots' cards; `botFrame` never sends CMD.CARD or CMD.READY.

`FlowField` (`public/shared/flowfield.js`, owned by sim core): `new FlowField(g, goalCells)`, Dijkstra over the CELL grid. It compares `g.structRev` to know when to rebuild and counts them in `field.rebuilds`. `cw.isObstacleCell` impassable; solid-struct
cells passable at extra cost `8 + hp/20`. `dirAt(x,y)` → `{dx,dy,blocker}`, blocker = struct in the next cell or null. Rebuilt lazily at most 2×/s after structures change.
Paths must keep clearance so big bodies don't wedge (the stuck rule is the backstop).

AI modules are pure functions over `g`: `ai_foes.js` `updateFoe(g, foe)`; `ai_bosses.js` `updateTruck(g, foe)`, `updateSteve(g, foe)`; `ai_bots.js` `botFrame(g, kid)` → frame, and may
call `g.command(kid.id, cmd)`; `waves.js` as in §5.

**Launch math.** The sim steps `x+=vx*dt; y+=vy*dt; z+=vz*dt; vz-=g*dt`. For `n = tick − t` (fractional on the client): `x = x0+vx*n*DT`, `y = y0+vy*n*DT`,
`z = z0+vz*n*DT − g*DT²*n*(n−1)/2`, exact at integer n; the client always uses this closed form. N = ticks of flight, N ≥ 2. Flat: `N = round(flight/DT)`, `vz = 0`,
`g = 2*z0/(DT²*N*(N−1))`. Lob: `flight = minFlight + dist*flightPerUnit` unless `opts.flight` is given; `N = round(flight/DT)`; `g = THROW.lob.gravity`; `vx = (tx−x)/(N*DT)`, `vy` likewise;
`vz = (g*DT²*N*(N−1)/2 − z0)/(N*DT)`. The ball lands at tick t+N exactly on (tx,ty,0). Rollers (`GIANT`,`BOULDER`) stay at z=0: `r(n) = grow ? min(rMax, r + grow*n*DT) : r`, grow in units/s.

**Events** (`g.emit`; every event gets `t`; non-integer numbers rounded to 2 decimals):
| e | fields | meaning |
|---|---|---|
| ball | id,k,by,tm,x,y,z,vx,vy,vz,g,r,grow,rMax,seq,lx,ly,ft | spawned. seq = input seq of the throw (humans), else 0. lx,ly,ft = landing point and ticks to landing for arcing balls |
| ballEnd | id,x,y,z,why,hit | why: ground/actor/struct/obstacle/out/shield/expire; hit = target id |
| splash | x,y,r,k | area impact. k = BALL kind or -1 |
| hit | id,amt,x,y,by,k | actor took damage. k = BALL kind, or -1 for melee |
| freeze | id,by | kid frozen |
| thaw | id,by | kid thawed (by=0 auto) |
| respawn | id,x,y | kid respawned |
| flee | id,x,y | foe gave up |
| spawn | id,k,x,y | foe arrived |
| sAdd | id,k,cx,cy,tm,hp,mhp,by | struct created |
| sHp | id,hp | struct hp changed |
| sDel | id,k,cx,cy,why | destroyed/demolished/reset |
| pAdd / pDel | id,k,x,y / id,k,x,y,by | pickup appeared / taken or expired |
| flakes | amt,x,y,tm | Flakes gained |
| pult | id,ang | flinger fired |
| card | id,card | kid took a card |
| bark | id,text | speech bubble from actor or struct id |
| banner | text,sub,kind | big centre text. kind: wave/boss/win/lose/info |
| emote | id,n | quick shout |
| quake | x,y,amt | camera shake, amt 0..1 (1 = Steve's pound) |
| sfx | name,x,y | one-shot, name from SFX |
| throw | id,lob | actor threw (arm animation) |
| slide | id | belly slide began (game.js, when slideT rises) |
| offer | to,cards | PRIVATE card offer: 3 card ids |
| deny | to,why | PRIVATE: noFlakes/badCell/tooFar/limit/noBalls |

Events with a `to` field are private: Room sends them only to that player's conn in their own EVENTS message, and drops them if offline. Session dispatches them on arrival
(no renderTick hold) and they still emit `fx`; handlers need no `to` check.

**Meta:** `{phase, wave, waveCount, waveName, waveSub, endsAtTick, dayT, blizzard, flakes:{[team]:n}, colonels:[{team,id,hp,mhp,nose}], foesLeft, round, roundWins:{[team]:n},
boss:{kind,name,hp,mhp}|null, ready:{have,need,ids:[playerId]}, scores:[{id,hits,freezes,thaws,built,flakes}], truce:bool, suddenDeath:bool, next:{foes:[{k,n}],from:[i]}|null,
cards:{[playerId]:[cardId]}, leaderId:number|null, pultLimit:{[team]:n}, patchesLeft:n}`. `endsAtTick` is number|null (null = no countdown, e.g. Siege FIGHT; then `view.secondsLeft` is null and the
HUD shows foesLeft). g.meta() floors flakes, rounds dayT to 3 decimals, rounds all hp to integers. `foesLeft = WaveRunner.remaining + live foes`.

**result:** `{mode, winnerTeam:number|null, winners:[playerId], won:bool, summary:string, players:[{id, stats, award:'mitten'|'foreman'|'cocoa'|'iceberg'|null}]}`. Golden Mitten = most hits, Foreman = most
built, Hot Cocoa = most thaws, Iceberg = most freezes.

## 8. Room and networking

### 8.1 One Room, three homes
`public/shared/room.js` holds the lobby and the running Game. It knows nothing about sockets:
```js
const room = new Room({ code, solo, onEmpty, log, now: () => ms, randomHex: (bytes) => string });
room.addConn(conn)              // conn: { id, send(stringOrArrayBuffer), close(reason) }. send takes ownership of an ArrayBuffer
room.onData(connId, data)       // only a string or an exact ArrayBuffer
room.dropConn(connId)           // no-op for a conn no longer bound to a slot
room.update(nowMs)              // call often; fixed-step accumulator; after 5 ticks in one call the accumulator resets to 0 (time is discarded, never banked)
room.setPaused(bool)            // skip ticks, discard elapsed time
room.destroy()
```
Room encodes once per conn and never reuses a buffer. Room never drops a conn for silence; liveness belongs to the transports. Tokens and seeds: 128 bits via `randomHex` (crypto.getRandomValues
in the caller), never `g.rng`, `Math.random` or `crypto.randomUUID`.

Hosts: (1) Node `server/index.js`. (2) Browser solo: `public/js/net/host-worker.js`, a module Web Worker running Room with a local conn. (3) Browser P2P: same worker, remote peers bridged by the main
thread. Worker timers avoid background-tab throttling, so a **desktop** host can alt-tab. On phones all JS stops when hidden, so a phone P2P host freezes the match; the lobby tells touch hosts "Keep this tab open and your screen on."

**Worker bridge:** main→worker `{op:'init',code,solo}`, `{op:'open',id}`, `{op:'data',id,data}`, `{op:'close',id}`, `{op:'pause',on}`; worker→main `{op:'send',id,data}`, `{op:'close',id,reason}`, `{op:'beat'}` every 1 s.
ArrayBuffers always go in the transfer list. The solo/host-local conn uses id `'local'`. Workers are created with `new Worker(new URL('./host-worker.js', import.meta.url), {type:'module'})`.

### 8.2 Connection modes
At boot `detectMode()` does `fetch('api/info')` with a 2 s timeout. JSON with `game:'Fort Flurry'` → **server mode** (WebSocket to the same origin and path + `ws`). Otherwise → **P2P mode**. Solo needs neither. The Title never waits for
it; Host and Join stay disabled until it resolves. `public/api/info` ships as a static marker with `game:null`, so on a static host the probe gets a clean answer and Chrome logs no 404 (SPEC 14: no console errors). The Node server answers `api/info` before its static handler, so it never serves the marker. A host with no such file still lands on P2P, at the cost of that one log line.
- Server URLs: `ws?create=1` makes a room; `ws?room=CODE` joins. Then the normal HELLO flow. `api/info` returns `{game, version, rooms, players, lanUrl}`; `lanUrl` is used for invites when the page is on localhost.
- **P2P loading:** `transport-p2p.js` runs `await import('../../vendor/peerjs.min.js')` on first use, then reads `window.peerjs.Peer` and `window.peerjs.util`. index.html has no tag for it. Never runs in the worker.
- **Options, both sides:** `{debug:0, config:{...util.defaultConfig, iceServers:[...util.defaultConfig.iceServers, {urls:'stun:stun.cloudflare.com:3478'}]}}`. Passing `config` replaces the defaults, so the merge is mandatory (it keeps PeerJS's TURN).
- **Joiner:** (1) uppercase the code; (2) `peer = new Peer(opts)`; (3) wait for peer 'open' with a 10 s timeout, never call `peer.connect()` before it; (4) `conn = peer.connect(P2P_ID_PREFIX + code, {reliable:true, serialization:'raw'})`, attaching open, data, close, error in the same tick; (5) connect() resolves on conn 'open'; rejects `{code:ERR.NO_ROOM}` on peer 'error' of type `peer-unavailable`, `{code:ERR.NET}` on `network|server-error|socket-error|socket-closed`, `{code:ERR.TIMEOUT}` on conn 'error' or after 20 s total; (6) after resolving, ignore peer 'error' and 'disconnected' and never destroy the peer for them: the data channel does not depend on the broker. A new connect() makes a new Peer.
- **Host startup:** on `unavailable-id` before first 'open' the Peer is already destroyed: new Peer with a new `makeRoomCode()`, up to 8 tries, then menu error. Send the worker `{op:'init',code}` only after the first 'open' (`peer.once('open')`).
- **Host running:** after the first 'open', peer 'error' is never fatal; log only. On 'disconnected', `if (peer.disconnected && !peer.destroyed) peer.reconnect()` after 1, 2, 4, 8, then every 15 s for the life of the room (reuses id and token; a new Peer would not). Count delays with worker `beat` messages, not main-thread timers. While `peer.disconnected`, `session.netStatus = 'invitesPaused'`, and the lobby shows 'Invites paused, reconnecting...'.
- **Host incoming:** in `peer.on('connection')` attach data, close, error synchronously; close at once if `conn.serialization !== 'raw'`, if `MAX_PLAYERS + 4` conns exist, or if 4 conns have not yet sent HELLO. `peer.on('call', c => c.close())`. Announce a conn to the worker only on conn 'open' (send before open is dropped). Before posting to the worker, data must be a string or ArrayBuffer of at most `MAX_INBOUND_BYTES`, otherwise close the conn.
- **Closing:** Room sends KICKED/ERROR/CLOSED before `conn.close(reason)`. In transport-p2p `conn.close(reason)` waits until `dataChannel.bufferedAmount === 0` or 500 ms, then calls `conn.close()` with no options. Never `close({flush:true})` with raw serialization.
- **Invite link:** `location.origin + location.pathname + '?join=' + code`.

### 8.3 Messages
JSON objects with `t` from `MSG`; hot paths binary (`public/shared/protocol.js`).
- HELLO `{v, name, look, token?}` → WELCOME `{you, token, code, hostId}` or ERROR `{code, msg}`. First message must be HELLO. A conn with no HELLO within 5 s is closed. An unknown or expired token is treated as a new player. A kicked token is refused for the room's life.
- `look = {hat,coat,scarf,skin}`, integer indices into `LOOK`. `sanitizeLook` clamps and falls back to `DEFAULT_LOOK`. Bots get a random look and the first unused `BOT_NAMES` entry.
- LOBBY ops per `LOBBY_OP`. LOBBY_STATE: `{code, hostId, state:'lobby'|'playing', settings, players:[{id,name,look,team,ready,isBot,connected}]}`, rebroadcast on every roster or connected change, including during a match.
- `settings`: `{mode, mapId, difficulty, waveCount}`. A joining human replaces the newest bot when the room holds 8 kids; `roomFull` means 8 humans. In server mode the next human inherits host rights if the host leaves. Lobby `ready` is only a check mark; the host can always Start. Start needs a kid on each team in Face-Off and 2 kids in FFA (Room enforces it too).
- START `{mode, mapId, difficulty, waveCount, seed, tick, players}` (LOBBY_STATE player shape), immediately followed by FULL.
- During a match, a joining or reconnecting conn gets WELCOME at once, and Room serves it right after the next flush, to that conn only: LOBBY_STATE, START, FULL, any pending offer in an EVENTS. FULL.tick equals the tick just flushed. On FULL, Session clears held events, pending frames and balls, and drops any later event with `t <= FULL.tick`. START with the seed already held is a resync: rebuild in place, no 'start' event. Session emits 'start' only after applying FULL, so view.map, meta, structs, pickups exist at first render.
- FULL balls use the `ball` event's keys with current values and `t = FULL.tick`, one code path. Client treats sAdd, pAdd and ball as upserts by id and ignores sHp, sDel, pDel, ballEnd for unknown ids.
- Siege late joiner: Room calls `g.addPlayer(p)` at once and Game spawns the kid at the next BUILD start. Until then `g.privateState` returns null, `g.ackSeq` 0, `queueInput` ignores them; snapshot `hasYou=0`; `view.me` and `view.you` null; camera on the Colonel; HUD says "You'll hop in at the next build phase." In FFA and Face-Off the kid spawns immediately.
- **Flush:** on every tick where `tick % SNAP_EVERY === 0`, in this order per conn: META if due, EVENTS (`{t:'ev', tick, ev:[...]}`) if any, then the snapshot. Game-stream messages are never sent between flushes. META `{t:'meta', tick, m:<Meta>}` is due at once when phase, wave, round, truce or blizzard changed, otherwise at most every 8 ticks when anything else changed.
- RESULT `{...g.result()}` when the match ends. Host may then send LOBBY `return`.
- CHAT `{text}` → CHAT_MSG `{id, name, text}`. PING `{c}` → PONG `{c, tick}`. KICKED `{}`, CLOSED `{reason}`, LEAVE `{}`.
- A second HELLO with a live token: Room sends the older conn CLOSED `{reason:'replaced'}`. On reclaim Room closes the slot's previous conn without marking AFK, binds the slot to the new conn, calls `g.setAfk(id,false)` and `g.resetInput(id)`.
- A dropped player's slot stays `RECONNECT_GRACE_S`, kid AFK, then removed. A room with no connected human is destroyed after RECONNECT_GRACE_S (immediately if solo).
- `protocol.js` exports: `encodeInput(frame)`, `decodeInput(buf)`, `encodeSnapshot({tick,ack,you,actors})`, `decodeSnapshot(buf)`, `sanitizeName`, `sanitizeChat`, `sanitizeLook`, `sanitizeSettings`, `makeRoomCode(rng)`, `isValidCode(code)`. Encoders return a new exact-length ArrayBuffer.

**Hardening.** Every inbound message is size-capped (`MAX_INBOUND_BYTES`), parsed in try/catch, type-checked, clamped; NaN/Infinity rejected. Rate limits are per-conn token buckets: inputs refill 45/s burst 150; cmds refill 20/s burst 40; chat refill 2/s burst 4; other JSON refill 10/s burst 30. A message over its limit is discarded silently. A conn is dropped only for a first message other than HELLO, 3 malformed messages, or 300 discards within 10 s. Server: `new WebSocketServer({maxPayload: MAX_INBOUND_BYTES, ...})`, `ws.binaryType='arraybuffer'`, `room.onData(id, isBinary ? data : data.toString())`; `MAX_ROOMS`, `MAX_CONNS_PER_IP`, `MAX_ROOMS_PER_IP`, over a limit send ERR.SERVER_FULL and close. 20 NO_ROOM results from one IP in a minute refuses that IP for 5 minutes. Trust X-Forwarded-For only when configured. Static handler: GET and HEAD only, decodeURIComponent in try/catch, resolve under public/, 404 unless the resolved path is inside public/.

**Back-pressure** (in transport-p2p.js host side and server/index.js, not Room; buffered = `conn.dataChannel.bufferedAmount` or `ws.bufferedAmount`): (1) buffered > `CONN_KILL_BYTES` closes the conn with reason 'slow'; the client reconnects and gets FULL. (2) ArrayBuffer whose first byte is `BIN.SNAPSHOT` and buffered > `SNAP_DROP_BYTES`: discard it (snapshots are self-contained, ack cumulative). JSON is never discarded. (3) P2P only: any host→client message over `CHUNK_BYTES`, of any type, is converted to bytes (TextEncoder for strings) and sent as frames `u8 BIN.CHUNK, u8 isText, u16 msgId, u16 index, u16 count, payload` back-to-back in one synchronous loop. The client transport reassembles, calls onmessage with the original string or ArrayBuffer, discards partials on close, rejects count over 256. A peer that sends BIN.CHUNK to the host is closed.

Binary input (14 B, LE): u8 BIN.INPUT, u32 seq, i8 mx, i8 my, u16 aim (0..65535 ↔ 0..2π), u8 btn, i16 tx, i16 ty. `decodeInput` rejects any other length.
Binary snapshot (LE): u8 BIN.SNAPSHOT, u32 tick, u32 ack, u8 hasYou, You (19 B, only if hasYou), u8 count, then Actors (17 B each). Every field is rounded then clamped to its type range, never wrapped. Aim wraps to 0..2π first.

### 8.4 Client netcode (`public/js/net/session.js`)
- `Input.sample()` returns `{mx,my,aim,btn,tx,ty}` with no seq; aim is radians in any range; tx,ty is the cursor world point every frame. `session.setFrameInput(frame)` keeps the latest values and ORs btn until the next fixed step, so short taps survive.
- `Session.update(dt)` clamps dt to 0.1 (at most 3 input frames per call), stamps seq 1,2,3... from each new connection, runs the frame through `decodeInput(encodeInput(frame))` so prediction uses exactly what the sim sees, sends it, and predicts. With `MAX_UNACKED` frames unacked it stops predicting and sending until ack advances.
- **Prediction:** a private object `{x,y,vx,vy,flags}` from the own Actor, `{slideT,slideCd,boardT,slowT,stunT,prevBtn}` from You, `mods` from `modsFromCards(meta.cards[me])`. On reconcile (once per update, against the newest snapshot) copy those, replay frames after ack, hide small corrections with a decaying visual offset, snap if > 120 units. A `respawn` event for me snaps at once. If view.me is null, send no frames.
- **Tick estimate:** on each snapshot sample `off = snap.tick − nowMs*SIM_HZ/1000`, keep the largest off of the last 2 s; `target = nowMs*SIM_HZ/1000 + off`. Each update: `err = target − est`; if `err > 15` then `est = target`, else `est += dt*SIM_HZ*clamp(1 + err*0.1, 0, 1.25)`. est can pause but never reverses. `interpDelay = clamp(INTERP_TICKS + 2*jitterTicks, INTERP_TICKS, 12)`, jitterTicks = max(off) − min(off) over that window, moving at most 0.02 ticks per tick. `renderTick = max(previous, min(est − interpDelay, newestSnapshotTick))`. est may not run more than 15 ticks past the newest snapshot, or a host pause of length P would cost P seconds with no interpolation afterwards.
- **Interpolation:** all snapshots enter a ring (cap 32). Other actors interpolate x,y and aim (shortest arc) between bracketing snapshots at renderTick; kind, team, hp, flags, aux come from the newer one. Actors more than 120 units apart between brackets snap. New actors appear at their position.
- **Balls** are not in snapshots. The client integrates each from its `ball` event with the closed form in §7, showing it when renderTick reaches t.
- **Own throws:** Session spawns local balls on the frame where it predicts a release, only if `you.balls >= cost`, `you.throwCd <= 0` and the kid is not FROZEN or LOCKED, using `THROW` and `mods.throwSpeedMul`. Own `ball` events (`by === me`) skip the hold queue. Linking: each own `ball` event takes the oldest unlinked local ball with `local.seq <= event.seq`, in order, so Triple Toss maps 3 to 3. A local ball's display age at local age a is `a − L*min(1, a/F)`, `F = max(0.8*flight, L/0.7)`, so it always moves at 30% speed or better and lands on server time. Before linking `L = ping/1000 + interpDelay*DT`. At link adopt the server's values and set `L = a + (ev.t − renderTick)*DT`. If that ball's ballEnd arrived but is held, cap display age at `(end.t − ev.t)*DT`. An unlinked local ball is removed after `2*ping + 250` ms with no fx. Own-throw fx play once, locally: Session emits no 'fx' for `throw` with id === me or for linked `ball` events.
- **Events** carrying `t` are held until renderTick reaches them, so a splat plays when the ball visibly lands. Nothing on the game stream is applied before FULL: there is no world yet, and FULL supersedes it. sAdd and sDel change `cw` on arrival; `view.structs` and `view.pickups` change at display time, same moment as fx. `cw.truce = meta.truce ? {...map.truce, active:true} : null`.
- **Background:** `session.setBackground(bool)`: main.js calls it on visibilitychange with `input.clearHeld()` and `audio.setHidden(bool)`, and while hidden drives `session.update` from `setInterval(250)`. Background means no input frames, no prediction, no 'fx', held display events discarded (state events still applied, keep only the newest banner), PING continues. On return renderTick jumps to newest snapshot minus delay, me resets to server state, expired balls drop, and dt passed to the renderer is clamped to 0.1.

### 8.5 Session API (consumed by UI, renderer, audio)
```js
class Session {  // .on(name, fn), .off(name, fn)
  constructor(connect, { name, look, token })   // connect() returns a fresh, unconnected transport
  start()         // Promise, resolves on WELCOME; rejects {code,msg} for any failure before WELCOME and does not also emit 'error'
  me, token, roomCode, isHost, lobby, inMatch, ping, connected, reconnecting, netStatus, result, offer
  view            // mutated in place every update()
  lobbyOp(op, data); chat(text); cmd(c, data); setFrameInput(frame); update(dtSeconds); setBackground(bool); leave()
}
// emits: 'lobby'(state) 'start' 'meta'(meta) 'chat'(msg) 'result'(result) 'reconnecting'({attempt,until}) 'reconnected'
//        'closed'({reason})  exactly once, after WELCOME, reason from CLOSE
//        'error'({code,msg}) non-fatal notices only
//        'fx'(event) for every event at its display time
view = {
  map, mapId, mode, phase, wave, waveCount, waveName, dayT, blizzard, meta, renderTick, secondsLeft,
  me,        // predicted Actor or null
  you,       // latest You record + .mods, or null
  actors,    // Actor[], me included, render-ready
  balls,     // [{id,kind,x,y,z,r,vx,vy,vz,g,lx,ly,ft,mine}]; r is current radius
  structs,   // [{id,kind,cx,cy,team,hp,maxHp,ownerId,bornAt}]; bornAt = sAdd t, 0 from FULL (no pop-in)
  pickups,   // [{id,kind,x,y}]
  players,   // Map id -> {id,name,look,team,isBot,connected}; built from START.players, rebuilt from each LOBBY_STATE
  cw,        // collision world for build previews
}
```
`session.offer`: array of 3 card id strings or null. Set by `offer`. Cleared by a `card` event with id === session.me (covers auto-pick). UI picks with `session.cmd(CMD.CARD,{i})`.
`view.you.mods` is the client source for prediction, local throw speed, the build range preview and the lob reticle radius.

**Reconnect (Session owns it).** On an unexpected transport close in a room, Session keeps the view, sets connected=false, emits 'reconnecting', and retries `connect()`+HELLO with the token at 0.5, 1, 2 s, then every 4 s until `RECONNECT_GRACE_S − 5`, then `closed({reason:'netLost'})`. A retry answered with noRoom ends with `closed({reason:'hostLeft'})` (P2P: after 3 consecutive noRoom results). The local transport never retries. A new connection always restarts input seq at 1.
**Storage:** main.js writes `sessionStorage['ff.session'] = {code, token, mode}` on WELCOME, removes it on leave or 'closed', never for solo or a P2P host. At boot a saved session with no `?join`, or a matching `?join`, resumes without the Invite card. A token for another code is ignored.
**Watchdog (§8.7).**

### 8.6 Transports (`public/js/net/`)
All expose `{kind, connect():Promise, send(data), close(), onmessage(data), onclose(reason)}`. `connect()` rejects `{code,msg}`; deadline 10 s for WS, 20 s for P2P. `kind`: 'local' (solo), 'p2pHost', 'ws', 'p2p'. `setPaused(bool)` on the solo transport only: the worker stops `room.update`. main.js pauses solo while hidden and while the Menu is open; multiplayer never pauses.
```js
// public/js/net/hosting.js
detectMode() -> Promise<'server'|'p2p'>       // cached
soloConnect() -> connectFn
hostConnect(mode) -> connectFn
joinConnect(mode, code) -> connectFn
```
Files: `transport-local.js`, `transport-ws.js`, `transport-p2p.js`, `hosting.js`, `session.js`, `host-worker.js`. On pagehide a P2P host sends `{t:MSG.CLOSED, reason:'hostLeft'}` on every conn and calls `peer.destroy()`; clients show 'The host left'. Clients send no LEAVE on pagehide, so a reload can reclaim its slot.

### 8.7 Liveness
Transport close events are a fast path, not a guarantee: PeerJS never reports a crashed peer. (1) PING on `setInterval(2000)` from WELCOME until leave, never from rAF. (2) Session watchdog on `setInterval(500)`, skipped for 'local' and 'p2pHost': in a match, no inbound message for 4 s sets connected=false and shows 'Connection hiccup...'; 10 s closes the transport and starts reconnect. In the lobby only a PING unanswered for 10 s counts. Ignore silence for 3 s after the tab becomes visible. (3) transport-p2p host: `lastRx` per conn, checked on every worker beat. No inbound for 10 s, or `conn.peerConnection?.connectionState === 'failed'`, closes the conn and posts `{op:'close',id}`. (4) Joiner: treat connectionState 'failed' as close. (5) server/index.js: `ws.ping()` every 5 s, no pong for 15 s calls `ws.terminate()`.

## 9. Records on the wire

**Actor** (17 B): `{id,kind,team,x,y,vx,vy,aim,hp,flags,aux}`. u16 id; u8 kind, team; u16 x*4, y*4; i16 vx*2, vy*2; u8 aim; u8 hp(0..1 ×255); u16 flags; u8 aux. For kids aux = charge 0..255 while CHARGING, thaw progress while FROZEN.
**You** (19 B): `{balls, maxBalls, special, specialN, warmth, maxWarmth, throwCd, slideCd, slideT, packT, boardT, slowT, stunT, prevBtn, frozenT, spendLeft}`. u8 balls, maxBalls, special (PICKUP id or 255), specialN; u16 warmth×10, maxWarmth×10; u8 (seconds×30) throwCd, slideCd, slideT, packT, boardT, slowT, stunT; u8 prevBtn; u8 frozenT (whole seconds to thaw or respawn, 0 when not frozen); u16 spendLeft (65535 = unlimited).

## 10. Physics module (`public/shared/physics.js`)

```js
createCollisionWorld(map) -> cw    // also has cols, rows, inBounds, hasObstacleOverlap, isStructCell, isSolidStructCell
cw.setStruct(cx, cy, solid, size=1, height=0)  // callers pass BUILD[kind].solid, .size||1, .height; also records non-solid Slick
cw.clearStruct(cx, cy, size=1)
cw.cellOf(x,y) -> {cx,cy}
cw.isIce(x,y); cw.isSolidCell(cx,cy) /*out of map, blocksMove obstacle, or solid struct*/; cw.isObstacleCell(cx,cy) /*out of map or blocksMove obstacle*/
cw.truce = {axis, at, active} | null
stepKidMotion(kid, frame, cw, dt)    // see below
collideCircle(cw, body, prevX, prevY, {ignoreStructs}?)  // -> {cx,cy}|null; push out of solids, slide along walls, enforce truce
raycastFlat(cw, x0,y0,x1,y1,z)         // -> {x,y,t,what,structCell}|null; blocksBalls obstacles + solid cells where z<height
repairCost(kind); segmentIntoCircle(x0,y0,dx,dy,cx,cy,r)
canPlace(cw, q, kind, cx, cy)          // -> 'ok'|'repair'|'patch'|'noFlakes'|'badCell'|'tooFar'|'limit'
demolishState(q, struct, playerId)     // -> 'ok'|'badCell'|'tooFar'
```
`q = {structs, actors, flakes, team, x, y, range, phase, mode, pultLimit, spendLeft, patchesLeft, playersPresent(id)->bool}`. `canPlace` order: out of map or overlap with any obstacle, including `blocksMove:false` ones → badCell; Siege within `entranceNoBuild` of an entrance → badCell; truce active-or-Face-Off and not on own half → badCell; farther than range → tooFar; a struct in the cell: own team, same kind, damaged → repair; Colonel cell with WALL tool in BUILD with patchesLeft and hp below max → patch; else badCell. Repair and patch also refuse on money: noFlakes if the team is short, limit if spendLeft is short; solid kind with an actor overlapping → badCell; team at `MAX_STRUCTS_PER_TEAM` or PULT at `pultLimit` → limit; flakes short → noFlakes; spendLeft short → limit; else ok. Both `Game.command` and the client preview call it. EV.DENY reuses these strings.

**stepKidMotion(kid, frame, cw, dt)** mutates kid in place and returns it. Deterministic: no rng, no globals. kid: `{x,y,vx,vy,slideT,slideCd,boardT,slowT,stunT,prevBtn,flags,mods}`. Rules: (a) From flags it reads only FROZEN and LOCKED; either one zeroes vx,vy, sets prevBtn=frame.btn, still counts down timers, and returns. All other flags are render output that Game derives from timers and btn. (b) If hypot(mx,my) > 1, scale to length 1. (c) `KID.chargeSpeedMul` applies whenever `frame.btn & (BTN.THROW|BTN.LOB)`, whatever the ammo. Speed uses `mods.speedMul`, `boardSpeedMul` while boardT>0, `slowSpeedMul` while slowT>0. (d) `stunT > 0` ignores mx,my and blocks slide start; drag still applies. (e) A slide starts when `(frame.btn & BTN.SLIDE) && !(kid.prevBtn & BTN.SLIDE) && kid.slideCd <= 0`: slideT=KID.slideTime, slideCd=KID.slideCooldown*mods.slideCdMul, velocity=KID.slideSpeed along (mx,my), or along aim when their length is under 0.1. While slideT > 0 direction comes from vx,vy. (f) Knockback only adds to vx,vy. Kids do not collide with actors here. (g) This function is the only code that decrements slideT, slideCd, boardT, slowT, stunT and writes prevBtn; timers tick per applied frame. Game only sets slowT, boardT, stunT on hits and pickups. (h) collideCircle enforces `cw.truce` by keeping the body on its pre-move side of `at`, at least its radius away; no team needed. Obstacle `rot` is art only.

## 11. Client structure

### 11.0 Module map (normative)
- `public/index.html`: `<canvas id="game">`, `<div id="hud">`, `<div id="screens">`, `<div id="dialogs">`, and a static `<div id="boot">Packing snow...</div>` that main.js removes; an inline classic script replaces its text after 8 s with 'Fort Flurry needs a newer browser (Safari 16.4, Chrome 111 or Firefox 114).' Then `<script type="module" src="js/main.js"></script>`.
- `public/js/main.js`: app state machine, rAF loop, wiring. Exposes `window.__ff = {session, renderer, input, ui, audio, app}`, with `session` a live getter. Exports `App` and `boot`, and skips auto-boot when `globalThis.__ffHarness` is set.
- `public/js/input.js`: `Input`. `public/js/ui/ui.js`: `UI`, `new UI(root, {input, renderer, audio})`, `.show(screen, data)`, `.setSession(s)`, `.update(view, dt)`, `.onFx(ev, view)`.
- `public/js/render/renderer.js`: `Renderer`. `public/js/render/sprites.js`: `drawKid`, `iconCanvas`, `ActorArt`. `public/js/audio/audio.js`: `AudioEngine`. `public/js/net/session.js`: `Session`. `public/js/net/hosting.js`: as §8.6.
- Only the UI owner writes `style.css`. Browser baseline: Safari/iOS 16.4, Chrome 111, Firefox 114.

**Renderer API:** `new Renderer(canvas, {quality})`; `.setMap(map)`; `.render(view, ui, dtSeconds)`; `.onFx(ev, view)`; `.resize()`; `.setQuality('auto'|'high'|'low')`; `.screenToWorld(px,py)` (CSS px relative to canvas top-left → {x,y}); `.worldToScreen(x,y)`; `.pickStruct(px,py,view)` (walk structs by descending draw key, return the first whose drawn box contains the point); `.setEdgeInsets(top,bottom)` (CSS px of canvas the HUD covers, reported by hud.js a few times a second, because the HUD is DOM above the canvas and edge arrows must stay out from under it).
**ui object** (Input is its only producer; main.js passes it to `render`): `{tool, toolCell:{cx,cy}|null, toolState:'ok'|'repair'|'patch'|'demolish'|'noFlakes'|'badCell'|'tooFar'|'limit'|null, toolValid (true for ok, repair, patch, demolish), buildRange, aimX, aimY, lobbing, charge (0..1, predicted locally), sticks:[{x,y,kx,ky,r,kind:'move'|'aim'|'lob',active}] (CSS px, empty unless mode 'touch'), reduceMotion}`. `tool` is a STRUCT id, 'demolish', or null; compare with `!== null`.
**sprites.js** (no Renderer instance needed): `drawKid(ctx, look, x, y, scale, {team, pose:'idle'})`; `iconCanvas(name, cssPx)` → canvas, names `tool:<STRUCT id>`, `tool:demolish`, `special:<PICKUP id>`, `card:<card id>`, `foe:<ACTOR id>`, `flake`, `ball`; `class ActorArt { setScale(s); draw(ctx, actor, info); drawColonel(ctx, struct, info); forget(id) }`. `draw` works in world units under the current ctx transform; `info = {time, dt, player, me:boolean, view}`. It keeps per-actor animation state internally (scarf tails, squash) keyed by id.
**Audio API:** `new AudioEngine()` creates nothing. `.unlock()` is idempotent, creates the AudioContext on first call, then `ctx.resume()`. main.js adds capture listeners on window for pointerup, touchend, click, keydown that call unlock, removed only when `ctx.state === 'running'`. Never rely on pointerdown or touchstart. Before unlock every method is a silent no-op, except setMusic, which remembers the last track and starts on unlock. `.onFx(ev, view)`; `.setMusic('menu'|'build'|'fight'|'truck'|'steve'|'win'|'lose'|null)`; `.setVolumes({master,music,sfx})`; `.ui('click'|'hover'|'join'|'deny')` (hover skipped on touch); `.update(view)`; `.setHidden(bool)` (true: suspend and stop the scheduler; false: resume, restart scheduling from `currentTime+0.1`, re-arm gesture listeners if still suspended or interrupted). Voice cap: at most 4 starts of one sound per 100 ms and 24 live voices. Ignores unknown names without throwing.
**Input API:** `new Input(canvas, renderer, opts)`; `.sample(view)` → `{mx,my,aim,btn,tx,ty}`; `.uiState(view)` → ui; `.setTool(k|null)`, `.tool`; `.mode` 'kbm'|'touch'|'pad' (last device used); `.press(name, down)` ('slide'|'lob', from HUD buttons); `.setEnabled(bool)` (false while chat, Menu or a dialog is open; sample gives zero move and no buttons, keeps aim); `.clearHeld()` (forgets all keys, pointers, sticks; a charge is cancelled, not thrown); `.forceFrame(frame|null)` for tests; `.setInMatch(bool)`; `.setShout(bool)`; `.on(name, fn)`. Events: `tool(k|null)`, `build({k,cx,cy})`, `demolish({cx,cy})`, `denied(why)`, `ready()`, `emote(n)`, `card(i)`, `chatOpen()`, `scoreboard(bool)`, `menu()`, `mute()`, `shoutMenu(bool)`, `shoutSelect(i)`, `nav(dir)`, `lobArmed(bool)`, `mode(m)`. `tx,ty` and aim hold still for 120 ms after a shot ends on any device: the camera eases home the moment `lobbing` drops and rAF outruns the fixed step, so otherwise the release frame reads its target through a moving camera and a lob misses the reticle.
**fx routing:** main.js forwards each fx to Renderer, Audio and UI. `banner` and `deny` are HUD DOM only. `bark`, `emote`, hit numbers and flake floats are Renderer only.

### 11.1 Controls and input rules
| Action | Keyboard+mouse | Gamepad (standard) | Touch |
|---|---|---|---|
| Move | WASD/arrows | left stick | left stick |
| Aim | mouse | right stick | right stick |
| Throw | hold/release LMB | RT | press/release right stick |
| Lob | hold RMB or Q, release | LT | Lob toggle on, then right stick |
| Cancel throw | Esc | B | release back inside the deadzone |
| Slide | Space | A | Slide button |
| Pick tool | 1–6 or tray | LB/RB cycle, demolish included | tray |
| Place | LMB | X | touch the ground |
| Demolish | X under cursor | demolish tool, then X | 7th tray entry, then touch |
| Drop tool | Esc, RMB, same key | B | tap same tool |
| Ready | R | Y | Ready button, BUILD only |
| Shout | V then 1–6 | D-pad down opens, up/down selects, A sends, B closes | Shout button |
| Pick card | click | D-pad left/up/right | tap |
| Scores | hold Tab | hold View/Back | tap the timer |
| Menu | Esc | Start | Menu button |
| Chat | Enter | none | lobby and results only |
| Mute | M | Menu | Menu |

Sticks (CSS px, inside safe areas): r=56, deadzone 0.18r. Left zone x<40% W and y>30% H, base appears under the thumb, never within 24 px of the screen edge. Right zone mirrors it. Slide and Lob sit above the right stick. Idle aim (touch and pad) = move direction, else last aim. Right stick press = THROW held. Aim uses the last vector outside the deadzone. A tap (under 180 ms, never left the deadzone) aims at the nearest visible enemy within 390 units, else current aim. Releasing inside the deadzone after a drag sends BTN.CANCEL. Lob toggle is sticky, stick ring turns gold. Lob target (touch and pad) = me + dir×(96 + m×(maxRange−96)), m = stick magnitude past the deadzone. Pad tool cursor = cell at me + aimDir×(2×CELL + m×(buildRange−2.75×CELL)), the extra 0.75×CELL keeping a cell's centre in range at full tilt. While a tool is active on touch: right stick hidden, left zone shrinks to its base circle, any other canvas touch is the build pointer; ghost at pointerdown, follows the drag, places on pointerup if valid. Dragging with WALL, ICEWALL or SLICK (mouse too) paints each newly entered valid cell, at most once per `KID.buildCooldown`. A touch press that starts on a patchable Colonel does not paint, so its release patches. On touch, a tool still out when FIGHT begins is put away. HUD buttons also act on a non-primary touch pointerup, because browsers click only for a lone finger; a trusted click within 600 ms after it is dropped.

Keys: listen on window and match `e.code`. Ignore when Input is disabled, when ctrl/meta/alt is set, when `e.isComposing` or `keyCode===229`, or when target is INPUT, TEXTAREA or SELECT. In a match only, preventDefault Space, arrows, Tab, Enter. Never in menus. HUD buttons have `tabindex=-1` and preventDefault on pointerdown. main.js blurs activeElement on 'start'. `setPointerCapture` on the canvas at button down. preventDefault contextmenu on #game and #hud. `clearHeld()` runs on window blur, visibilitychange, pagehide, pointercancel, lostpointercapture. Touch pointercancel resets only that pointer's stick. Chat: on chatOpen call clearHeld, setEnabled(false), focus; Enter sends unless composing; Esc closes. Esc priority: close chat, close shout menu, cancel charge, drop tool, open Menu. Digits mean shouts while the shout menu is open. X, demolish tool and repair call `renderer.pickStruct` before screenToWorld. Gamepad: poll in sample(), `mapping==='standard'` only, radial deadzone 0.18. Menus outside a match use mouse, touch or keyboard.

### 11.2 Screens
Title (animated, name entry) → Play Solo / Host with Friends / Join with Code / How to Play / Settings. Mode labels from `MODE_NAME`, team labels from `TEAM_NAME`.
**Invite card** (`?join=CODE`): `code = param.toUpperCase().replace(/[^A-Z]/g,'')`; if invalid show noRoom; else "Join room ABCD", a name field prefilled from localStorage or a random name like Snowy Otter (also the fallback for empty), one Join button. Connecting always takes one tap, which is also the audio gesture; the only exception is a saved session.
**Join with Code:** field with `autocapitalize=characters autocomplete=off autocorrect=off spellcheck=false enterkeyhint=go`; a pasted invite link gives its code, uppercase while typing, Join enabled at 4 valid letters, hint 'Four letters, no vowels'. **Connecting:** 'Finding room ABCD...' with Cancel.
**Lobby:** big room code, Copy Invite Link, player cards with look editor (hat, coat, scarf, skin; kid preview via `drawKid`), team picker, host controls (mode, map, difficulty, length, add/remove bots, kick, Start), chat. Length shows in Siege only. Difficulty shows in Siege, and elsewhere whenever there are bots, since it sets how sharp they are. Solo uses the same Lobby with code, invite, chat, kick hidden. Start disabled with the reason shown until Face-Off has a kid on each team and FFA has 2 kids. Non-hosts see 'Waiting for {host} to start'. Copy Invite: `navigator.share` on coarse pointers if available, else clipboard if `isSecureContext`, else select a visible readonly field and `execCommand('copy')`. Always show the link; button says 'Copied!' for 2 s. Touch P2P hosts see "Keep this tab open and your screen on."
**In match:** HUD; cards non-blocking during BUILD; Tab scoreboard; Menu overlay (Resume, Settings, How to Play, Fullscreen if supported, Leave). Solo pauses while the Menu is open; multiplayer says it doesn't. Reconnecting overlay ("Reconnecting... your kid is taking a snow nap." with Leave, Input disabled). Waiting-to-join overlay. Connection hiccup toast. Rotate hint only in a match, only when `input.mode==='touch'` and `innerHeight > innerWidth`.
**Results:** outcome, awards, stats. Host gets Play Again (LOBBY return then start) and Lobby. Others get 'Waiting for {host}...' and Leave. Both follow hostId. The viewer's win is `viewerWon(result, session.me)` (protocol.js): `result.won` in Siege, so a friend who joined too late for a kid shares the team's result, else `result.winners.includes(me)`.
**History:** pushState once on entering a room. popstate while in a room re-pushes and opens 'Leave the game?' [Stay][Leave]; a P2P host also sees 'This ends the game for everyone.' beforeunload prompts only for a P2P host or during a match. Leaving calls replaceState to strip ?join. pageshow with persisted=true calls location.reload(). `navigator.wakeLock?.request('screen')` in try/catch on entering a room and on return to visible.
**Error dialog, exact copy:** noRoom 'Can't find room ABCD. Check the code with your friend.' [Try another code] · roomFull 'Room ABCD is full.' · badVersion 'Fort Flurry was updated. Reload to join.' [Reload] · serverFull 'The server is packed. Try again soon.' · timeout 'Couldn't reach room ABCD. The host may be offline, or this network blocks direct connections.' [Retry] · net 'Can't reach the online service. Play Solo still works.' · kicked 'The host removed you from the room.' · hostLeft 'The host left. Thanks for playing!' · netLost 'Connection lost.' · replaced 'You joined from another tab.' · rate 'Disconnected for sending too much.'
**deny copy:** noFlakes 'Not enough Flakes', badCell 'Can't build there', tooFar 'Too far away', limit 'Build limit reached', noBalls 'Out of snow! Stand still to pack.'
`localStorage` remembers name, look, volumes, quality, reduceMotion, tips seen. All player text goes through `textContent`.

### 11.3 Page shell
`<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">`, `<meta name="apple-mobile-web-app-capable" content="yes">`. `html,body {height:100%; margin:0; overflow:hidden; overscroll-behavior:none}`. App root `{position:fixed; inset:0; height:100dvh}`, never 100vh. Screens scroll inside themselves. `#game {position:absolute; inset:0; width:100%; height:100%; touch-action:none}`. `#hud {position:absolute; inset:0; pointer-events:none; padding: env(safe-area-inset-*)}`; `#hud button {pointer-events:auto; touch-action:manipulation}`. Everything except inputs `{user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; -webkit-tap-highlight-color:transparent}`. Inputs `{font-size:16px; user-select:text}`. preventDefault on gesturestart. main.js calls `renderer.resize()` from a ResizeObserver on the app root and from visualViewport 'resize'. Title, Invite, Lobby and Results must work in portrait from 320×568 and in landscape down to 640×300. Fullscreen: Menu item only if `document.fullscreenEnabled`, never automatic; after entering, `screen.orientation.lock('landscape')` in try/catch. How to Play on iPhone says Add to Home Screen gives full screen.
**Compact HUD** at `@media (max-height:480px)`: one 36 px top strip with warmth and ball pips left, timer centre with a thin Colonel bar, Flakes and Menu right. Boss bar replaces the wave name, teammates become dots, ping shows only above 200 ms. Tray: seven 44×44 buttons, costs only, open during BUILD, collapses to one hammer button during FIGHT. Cards never cover the ground: a pulsing 'Pick a card' pill opens a dismissible sheet. Lobby chat collapses behind a button on touch.

### 11.4 HUD and tips
HUD: warmth bar, ball pips, special icon, slide cooldown, Flakes, build tray with keys, costs and `n/limit` for flingers, your share when fair share is on, phase/timer top centre, Colonel hp bar(s), boss bar, wave preview with foe icons during BUILD, teammates list, ping, frozen message ("You're frozen! Thawing in 9"; Face-Off and FFA "Back in 3"), contextual tips. Team-based widgets use `view.players.get(session.me).team`.
Tips: one at a time, each shown once per browser via localStorage, computed from view; touch and pad swap the key names. First BUILD: 'Protect Colonel Carrot! Press 1, then click near him to build.' · Flakes below 2, or 10 s left: 'Press R when you're ready.' · FIGHT starts: 'Click to throw. Hold longer to throw harder and farther.' · you.balls ≤ 1: 'Low on snow! Stand still to pack more.' with pulsing pips, repeated until the kid has packed 3 times · A teammate freezes: 'Stand next to a frozen friend to thaw them.' · You freeze: 'Brrr! You'll thaw soon.' · First Lid Kid: 'Lids block throws. Hit from the side, or hold right-click to lob.' · First Thief: 'Thief! Freeze it to save the nose!' · First offer: 'Pick a card!'

## 12. Art direction

**Cozy storybook winter**, not pixel art. Soft shapes, no black outlines, generous rounded forms, a limited palette of powder blues and lilac shadows lit by saturated scarf colors. 3/4 top-down view: objects show top and front. Think hand-painted picture book drawn entirely with Canvas 2D paths.

- Ground: pre-rendered soft snow with low-frequency lilac drifts and tiny sparkles, plus trail layers (footprints, slide marks, sled ruts, splats).
- Kids: chibi, ~40 px tall, puffy coat, big bobble hat, scarf tails that trail with secondary motion, mittens, boots. Squash and stretch on throw and hit. Crouch while packing. Frozen = translucent ice block. In Face-Off the scarf, hat bobble and name tag use `TEAM_STYLE` color regardless of look; Siege and FFA use the look as chosen. Your own kid has no name tag and gets a soft ground ring.
- Foes: readable from silhouette and color at a glance (Slinger with goggles, Big Kid twice the size, Lid Kid holding a dented lid, Thief in white with a mask, Sledder on a red sled).
- Structures: chunky blocks with visible top and front face, ambient shadow, cracks at damage thresholds. Ice walls translucent cyan with a specular streak. Spare Coat: a stuffed puffy coat and bobble hat propped on a shovel, kid height, in the team color. Spoon Flinger: wooden spoon catapult, animates on fire. Cocoa Stand: tiny wooden booth with steam. Slick: glossy patch. **Colonel Carrot is the only snowman in the game.**
- Colonel Carrot: three-ball snowman twice kid height, bucket helmet with stars, carrot nose, coal eyes that follow the nearest threat, stick arms in a salute. Loses bits as hp falls. Reacts on hit.
- The Sno-Cone Truck: rounded mint-and-cream step van, striped awning, a giant paper cone on the roof that is the turret, rear double doors that swing open when the aux door bit is set. No face, clown or driver mascot, no plow blade, nothing that pushes snow, not a blue-and-white soft-serve truck.
- Abominable Steve: pear-shaped yeti about three times kid height, dusty lilac shag, tired eyes, no fangs, a too-small mustard sweater with a stitched STEVE name tag, a tiny bobble hat. Never white fur with a blue face. He never offers or eats snow cones. With FLEEING he draws sitting with cocoa.
- Ice Chunk: clear cyan faceted ball with a sparkle trail.
- Time of day: palette grade per `dayT` (rose dawn, crisp noon, amber dusk, deep blue night). At dusk, lamp posts and house windows glow via a light mask. Blizzard = dense angled snow and reduced contrast.
- Juice: impact puffs, ice shards, floating damage numbers, hit flash, camera shake (`reduceMotion` off), snow splat on the lens when you're hit, ball shadows that separate on lobs, landing reticle for lobs and foe lobs, trajectory hint while charging, name tags, speech bubbles. Renderer draws edge arrows for frozen teammates, your Colonel if hit in the last 3 s, the boss, and the last foes when `foesLeft ≤ 3`.

**Camera** (owned by Renderer): `sx=(x−cam.x)*zoom`, `sy=(y−cam.y−z*Z_LIFT)*zoom`, `Z_LIFT=0.8`. The ground plane is not squashed, so aim angle equals screen angle. `zoom=clamp(sqrt(cssW*cssH/VIEW_AREA),0.6,4)`, VIEW_AREA 700000, or 500000 on coarse pointers; changes only in `.resize()`. Target: view.me, led by 0.5×(aim point − me) while lobbing (an ordinary throw never moves the camera), smoothed over 0.25 s, clamped to the map. If view.me is null: own Colonel, else map centre.
**Backing store:** `pixelRatio=min(devicePixelRatio,2,sqrt(MAX_PIXELS/(cssW*cssH)))`, MAX_PIXELS 2.6e6 high, 1.2e6 low; `canvas.width=round(cssW*pixelRatio)`. `setQuality('auto')`: mean frame time over 24 ms for 3 s drops to low for the rest of the match. Targets: 60 fps on laptops, at least 30 on phones.

**Frame order**, one canvas, `getContext('2d',{alpha:false})`: 1 ground cache. 2 trail layers. 3 flat pass: Slick, shadows, lob reticles and telegraphs, build range ring, ghost, wave-preview arrows. 4 y-sorted pass: obstacles, non-flat structs, pickups, actors, balls with z≤48. Keys: actor, pickup, ball = y; struct = (cy+size)×CELL; rect obstacle = y+h; circle obstacle = y; ties by id. 5 x-ray pass: redraw own kid and teammates at 0.3 alpha when a higher-key item overlaps their sprite box. 6 high pass: balls with z>48, particles. 7 grade: one tint fillRect (multiply on high, plain alpha on low), light mask, blizzard. 8 screen pass, ungraded: name tags, bubbles, numbers, lens splats, edge arrows, `ui.sticks`.
Light mask: a canvas at 1/4 backing size: fill the night colour, destination-out one pre-rendered radial sprite per on-screen light, one scaled blit. Skip when night amount is 0. On low use tint only; night must stay readable without the mask. Blizzard: two scrolling pre-rendered 512 px tiles, no per-flake draws.
**Caches:** ground at 1 px per world unit (0.5 on low), not scaled by zoom or DPR, with ice and decor baked in at setMap. Trail at 0.5 px per unit (0.25 on low) as two layers: stamps go to the newer one, the two cross-fade over 60 s and the older is then cleared, so marks fully vanish. Sprites rasterized at `min(3, ceil(zoom*pixelRatio*2)/2)`, keyed kind|variant|look|pose, rebuilt only on resize. No cache over 4096×4096; total under 128 MB. Kid bodies are cached sprites, scarf tails are live paths, squash is a drawImage transform. Name tags cached per name.
**Not allowed in per-frame code:** `ctx.filter`, `shadowBlur`, `getImageData`, `createRadialGradient`, `measureText`.

## 13. Audio direction

All synthesized with Web Audio. audio.js derives SFX from events: throw whoosh (pitch by power), soft snow splat, ice crack, wall thunk, build pop, freeze chime, thaw shimmer, flake tinkle, card flip, wave horn on a kazoo-like voice. `SFX` names: Colonel harrumph, nose grab, sled crash, truck doors, truck horn, Steve roar, Steve pound, cheer. Spatialized by distance and pan.
**Truck chime:** only this original phrase on a detuned music-box voice: MIDI notes [74,79,76,81,78,74,76,69], lengths in eighth notes [1,1,1,1,2,1,1,4], 3/4 at 132 bpm, one bar of rest between loops. Never the Mister Softee jingle, Turkey in the Straw, The Entertainer, Music Box Dancer, Pop Goes the Weasel or Greensleeves.
Music: original procedural tunes scheduled by lookahead. Menu: gentle music box. Build: light plucky loop. Fight: bouncy bass + brushed percussion, intensifies with foe count. Truck and Steve themes. Win and lose stingers. Never copy an existing melody.

## 14. Definition of done

- `npm test` and `npm run test:e2e` pass; `npm start` serves the game; `public/` alone works on a static host in P2P mode.
- Solo, server-mode multiplayer and P2P multiplayer all complete a match in real browsers without console errors.
- Every mode, map, foe, boss, card, structure and pickup works and is visible and audible.
- Host survives malformed traffic, disconnects, and reconnects.
- Controls work on keyboard+mouse, touch and gamepad in a match; menus use mouse, touch or keyboard. Layout works from a phone in landscape to 4K.

## 15. As built

Seven engineers built this in parallel from the sections above. Where the code went further or filled a gap, the ruling is recorded here. Anything that changed the contract is also written into its own section. "Kept" means the behavior stands as described.

**Sim.** Kept: foe knockback is a decaying internal `pushX,pushY` scaled by body size, because AI overwrites `vx,vy`; kids take it as velocity; bosses take none and no stun. Kept: FLEEING foes don't count in `foesLeft` or hold the wave, except a FLEEING boss, which holds it so its exit plays out, with a 30 s net; other fleeing foes leave along a border flow field, vault structs, and have a 20 s net. Kept, gaps filled for balls: rollers bypass SHIELDED; sliding kids are immune to them; BOULDER rolls through structs hitting each once and only `blocksBalls` obstacles stop it; GIANT stops at structs; Slushball is one burst, not a hit plus splash; splash reach includes the target's body radius; a flat ball hitting your own wall ends there with no damage. Kept: `g.los` counts reaching the struct at the far end as clear. Kept: one award per kid, passing to the next best; Spring Spoon uses the strongest single kid's multiplier; `stats.freezes` counts foes defeated too; repairs aren't `built`. Kept: flinger balls credit their owner but raise no grudge. Kept: an enemy Slick slows kids in Face-Off and FFA, which client prediction learns through reconcile. Values the spec left open: pickups last 30 s, at most 12 on the map; FFA pickups land on a random open point; `dayT` quantizes to 0.005 so it doesn't force META traffic; `meta.patchesLeft` is TEAM.A's, which is right because only Siege can have a hurt Colonel in BUILD. Guards: `g.sfx` drops unknown names; `spawnFoe` clamps to the map; kids are pushed clear of solids when placed; non-finite frames are sanitized in `applyFrame`; `queueInput` caps a queue at 64 with the same drop rule; frozen kids building get `badCell`; the teammate demolish cooldown denies with `limit`. **Changed in integration:** the host-only refusal of a healthy-Colonel patch moved into `canPlace`, so the preview and the host agree and walls behind him can be placed.

**World.** Kept: the pond is a union of ellipse and rect lobes because `ice` has no holes; all solid obstacles mirror across the rope for Face-Off fairness, with costume free to differ. Kept: 18 cards, not 14, all with art. Kept: the Truck bumps kids it drives through for half its dmg plus knockback. Kept: bots-only forts scale with difficulty, and raiders hold back on Cozy and Normal, to keep PvP beatable; FFA bots build three cover walls and no flinger. Kept: WaveRunner speaks the wave-start and wave-cleared lines and foes' give-up lines; Colonel hurt barks stay in game.js. Kept: lantern lights at the fort points, merged by the renderer with its own. Kept: the bot repair cap is enforced twice, harmlessly.

**Net.** Kept: in server mode host rights pass on LEAVE or when the slot goes after the 60 s grace, not on a plain drop, so a host reload keeps the role. Kept: a kicked token gets KICKED and `start()` rejects `{code:'kicked'}`; an IP banned for bad codes gets ERR.RATE; no HELLO in 5 s is enforced in `Room.update`; a message whose handler throws counts as a malformed strike. Kept: `view.balls` has current x,y,z,r and launch vx,vy,vz, which the reticle filter relies on. Kept: frames are at most CHUNK_BYTES including the 8-byte header; `sanitizeName` returns '' so callers own the fallback; `sanitizeSettings` takes an optional `base`. Kept: Session also has `clock`, `transport`, `setPaused`, and netStatus values 'ok', 'hiccup', 'reconnecting', 'invitesPaused'; a retry answered roomFull or badVersion ends in netLost; each WELCOME wait is capped at 10 s. Kept: a back-pressure kill sends no reason, since nothing can get through a full pipe. Kept: a P2P conn not open in 20 s is dropped; a broker reconnect stuck for 20 beats is forced. Kept: Room steps on after OVER until RETURN; during a match only KICK and RETURN work; KICK on a bot removes it. Extra exports: protocol.js `DEFAULT_SETTINGS, SEND, sendVerdict, chunkMessage, ChunkAssembler, CHUNK_HEADER_BYTES, MAX_CHUNKS`; transport-p2p.js `setPeerConfigOverride, loadPeerJs`; server `startServer, makeWsConn`, with `startServer()` returning `{port, rooms, server, wss, close}`. Env: `PORT, HOST, TRUST_PROXY=1`.

**Render.** Kept: on high the grade is a tinted paper-grain multiply plus one soft-light blit, and the light mask blits with multiply; low stays a single fill. Kept: blizzard on high adds a third fog tile and a pale wash. Kept: only the older trail layer fades. Kept: "smoothed over 0.25 s" means a first-order filter that settles in 0.25 s. Kept: auto quality measures wall-clock gaps, ignores gaps over 250 ms, and resets on `setMap`. Kept: obstacle sprites cap at 2× raster and the bank at 44 MB, to stay under 128 MB beside ActorArt's 64 MB. Kept: fences, the rope and a vertical bench's rail lean up to 13 units as an art cheat; collision is untouched. Kept: the renderer adds lights for your kid, Cocoa Stands and the Truck, and the extras listed in its report (lane warning, glints, smoke, breath, puffs, long shadows, frost overlay, pips, floats). **Changed in integration:** edge arrows stay clear of the HUD, since ones due north or south used to land behind the timer stack or the tray. Contract notes: `renderer.js` exports `Z_LIFT, VIEW_AREA` and has `renderer.stats`; it calls `art.forget` on setMap and when an id changes kind, because ids restart each match; ActorArt owns hit flash; the renderer draws shadows, the own-kid ring and the paper crown.

**Characters.** Kept: LOOK has no hat colour, so the hat takes the scarf colour. Kept: `drawKid`'s (x,y) is the ground under the feet, and team is passed only in Face-Off. Kept: ActorArt has no `onFx`; every reaction comes from snapshot data, which means a cancelled charge plays one beat of follow-through. Kept: sprite keys are numbers in 1024 px pages, capped at 16 (64 MB), with LRU eviction. Kept: Steve is a cut-out puppet and never mirrored; the Truck's cone and doors and the Colonel's face and arms are drawn live. Kept: `ActorArt.drawColonel` hides the nose itself from `view.actors`. Kept: `iconCanvas` returns a fresh canvas each call, with an unknown name drawing a flake. Unasked but kept: Colonel team sash, cheering kids, the Truck's white flag, the crashed sled, Steve's stars, the Thief hoisting the carrot.

**UI.** Kept: a disabled Input still sends a pending CANCEL for 120 ms, so opening chat mid-charge can't throw. Kept: `lostpointercapture` and `pointercancel` clear only a pointer still held, since a normal pointerup fires them too. Kept: keyup skips the keydown guards so keys can't stick, and releasing Meta clears held keys, because macOS sends no keyup under Cmd. Kept: Slide and Lob use `touch-action:none`. Kept: drag paint places ok or repair, never patch. Kept: a stick's vector is measured from the press point. Kept: name inputs are 19 px, above the iOS zoom threshold. Kept: leaving confirms during a match and for a P2P host. Added: a Sound button in the Menu, a tap-dismissible rotate hint, D-pad on the Menu, Esc backing out of Join, 1.5× or 2× HUD scale on very large 1× screens. `main.js` fetches `api/info` itself for `lanUrl`. **Changed in integration:** Difficulty shows outside Siege when there are bots, because the bots read it and a value set in Siege would otherwise apply invisibly; a lob's target holds across the release frame; the demolish tool looks past the Colonel's sprite; the pad tool cursor stops short of the range limit, because at full tilt most directions used to land on a cell just out of reach.

**Audio.** Kept: `audio.ctx` is public and null before unlock; also `.state, .stats, .play(), .at(), .duck(), .now`. Kept: `setVolumes` and `setHidden` remember their values before unlock, because main.js calls them at boot. Kept: `update(view)` drives intensity and cues while main.js alone picks tracks. Kept: on a Siege boss wave with no boss yet, `setMusic('fight')` fades out so the boss theme can enter. Kept: the wave horn comes from the phase change, and the deny sound from hud.js. Kept: emote gets a soft blip, as "Renderer only" is read as visual routing. Kept: one bar of rest for the chime voice only; the waltz plays through it. Kept: the 24-voice cap applies to SFX, and music is bounded by the score. Kept: sliders use a 1.6 power taper balanced for the store.js defaults. Kept: footsteps, packing pat, countdown tick, cleared flourish, pound telegraph, repair pop and blizzard wind, and Fight and Build resuming at their next section. `offline.js` and `score-check.js` are soundboard-only.

**Tests.** `test/e2e/run.mjs` (`npm run test:e2e`) drives real Chrome through every stage. Its wave jumps, boss hp changes and Colonel top-ups live in `test/e2e/hooks.mjs` and reach a Game through `startServer().rooms` inside the test process; nothing in `public/` or `server/` knows they exist.
