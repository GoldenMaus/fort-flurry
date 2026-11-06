// Fort Flurry — seeded randomness for the simulation.
//
// Room hands Game a 128-bit hex seed, but tests pass small integers, so anything
// String() can flatten is a valid seed. The same seed must give the same match on
// every engine, which rules out the built-in generator and anything built on floats:
// sfc32 is pure 32-bit integer arithmetic.

// A hex seed differs from its neighbour in a few low bits. Hashing spreads that
// difference across all four words of sfc32 state, so seeds "1" and "2" do not start
// with near-identical streams.
function seedWords(seed) {
  const text = String(seed);
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// Returns a function, not an object with a method, so it can be passed around bare:
// rollCards(g.rng, ...) has no `this` to lose.
export function createRng(seed) {
  const word = seedWords(seed);
  let a = word();
  let b = word();
  let c = word();
  let d = word();
  const rng = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // The first outputs of sfc32 still echo the seed words; burn them off.
  for (let i = 0; i < 12; i++) rng();
  return rng;
}
