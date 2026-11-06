# Fort Flurry

A build-then-battle snowball game for up to 8 friends, right in the browser. Spend your Flakes on walls, decoys and Spoon Flingers, then hold the block when the snow starts flying.

**Play: https://goldenmaus.github.io/fort-flurry/**

## Play with friends

1. Open the link and choose **Host with Friends**.
2. Send your friends the invite link, or the four-letter room code.
3. Pick a mode and map, add bots if you like, and press **Start**.

There is nothing to install and no accounts. One player's browser hosts each match, so the host keeps their tab open until the game is over. Phones and tablets can join; a computer makes the best host, because a phone pauses the game when its screen is off or the tab is hidden.

## Modes

- **Siege:** everyone together against waves of neighborhood kids and two bosses. Keep Colonel Carrot standing.
- **Fort Face-Off:** Mitten Brigade against Scarf Squad, each team guarding its own fort.
- **Free-for-All:** every kid for themselves.

Three maps: Maple Court, Wobble Pond and Recess Yard.

## Controls

| Action | Keyboard and mouse | Gamepad | Touch |
|---|---|---|---|
| Move | WASD or arrows | Left stick | Left stick |
| Aim | Mouse | Right stick | Right stick |
| Throw (hold for power) | Left mouse | RT | Press and release right stick |
| Lob over walls | Right mouse or Q | LT | Lob toggle, then right stick |
| Slide | Space | A | Slide button |
| Pick a building | 1 to 6 | LB / RB | Tray |
| Place | Left mouse | X | Touch the ground |
| Demolish | X | Demolish tool, then X | Last tray entry |
| Ready up | R | Y | Ready button |
| Shout | V, then 1 to 6 | D-pad down | Shout button |
| Scores | Hold Tab | Hold View | Tap the timer |
| Menu | Esc | Start | Menu button |
| Mute | M | Menu | Menu |

## Run it yourself

The `public/` folder is the whole game. Any static web host can serve it, and matches then run peer to peer through the public PeerJS broker. A small Node server is included if you would rather host matches centrally:

```bash
npm install
npm start
```

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` covers the simulation, world, protocol and networking. `npm run test:e2e` plays real matches in Chrome, including solo, server and peer-to-peer games.

## How it is built

The game rules in `public/shared/` use no browser or Node APIs, so the same code runs in a Node server, in a Web Worker for solo play, and in the host player's browser for peer-to-peer matches. Clients predict their own movement and reconcile against the host. The full design is in [docs/SPEC.md](docs/SPEC.md).

Inspired by the snowball-fort games of the late 1990s. All names, characters, art, music and levels here are original.
