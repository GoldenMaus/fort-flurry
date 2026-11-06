// Fort Flurry's drawn identity: the logo, the title scene and the small interface icons.
// System fonts can't look hand-lettered, so the logo letters are our own stroke skeletons, thickened
// and layered. Everything here is a constant string built from literals, which is why these are the
// only strings allowed through trustedHtml.

// Each letter is a skeleton on a 100-unit cap height. The heavy round stroke gives the fat, soft
// letterform, and `cap` traces where snow settles on top of it.
const LETTERS = {
  F: { w: 60, d: 'M0 0V100M0 0H60M0 47H47', cap: ['M-10 -12H68'], drips: [[20, -4, 6], [50, -5, 4.5]] },
  O: {
    w: 76,
    d: 'M38 0C62 0 76 22 76 50S62 100 38 100S0 78 0 50S14 0 38 0Z',
    cap: ['M12 -10C26 -17 50 -17 64 -10'],
    drips: [[22, -5, 5.5], [55, -5, 4]],
  },
  R: { w: 72, d: 'M0 100V0H36C74 0 74 56 36 56H0M36 56L70 100', cap: ['M-10 -12H38C50 -12 58 -9 66 -2'], drips: [[12, -4, 5.5], [44, -6, 4]] },
  T: { w: 78, d: 'M-5 0H83M39 0V100', cap: ['M-14 -12H92'], drips: [[8, -4, 5], [39, -3, 7], [70, -4, 4.5]] },
  L: { w: 56, d: 'M0 0V100H56', cap: ['M-10 -12H10'], drips: [[2, -3, 5.5]] },
  U: { w: 74, d: 'M0 0V58C0 116 74 116 74 58V0', cap: ['M-10 -12H10', 'M64 -12H84'], drips: [[0, -3, 5], [76, -3, 4.5]] },
  Y: { w: 80, d: 'M0 0L40 50L80 0M40 50V100', cap: ['M-13 -11H7', 'M73 -11H93'], drips: [[-3, -3, 5], [84, -3, 4.5]] },
};

const WOBBLE = [-3.5, 2.5, -1.5, 3, -2.5, 2, -3, 1.5, 3, -2];
const LIFT = [3, -3, 2, -2, 2, -3, 3, -2, 2, -3];

function letterMarkup(ch, x, y, scale, index, tone, uid) {
  const L = LETTERS[ch];
  const rot = WOBBLE[index % WOBBLE.length];
  const dy = LIFT[index % LIFT.length];
  const caps = L.cap.map((d) => `<path class="lg-cap" d="${d}"/>`).join('');
  const drips = L.drips.map(([cx, cy, r]) => `<circle class="lg-drip" cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  return `<g transform="translate(${x} ${y + dy}) scale(${scale}) rotate(${rot} ${L.w / 2} 50)">
    <g class="logo-letter" style="--i:${index}">
      <path class="lg-ink" d="${L.d}"/>
      <path class="lg-edge lg-edge-${tone}" d="${L.d}"/>
      <path class="lg-body" stroke="url(#lg-${tone}-${uid})" d="${L.d}"/>
      <path class="lg-shine" d="${L.d}"/>
      ${caps}${drips}
    </g>
  </g>`;
}

function wordMarkup(word, top, scale, startIndex, tone, centre, uid) {
  const gap = 42;
  const letters = [...word];
  const width = letters.reduce((sum, ch, i) => sum + LETTERS[ch].w + (i ? gap : 0), 0) * scale;
  let x = centre - width / 2;
  return letters.map((ch, i) => {
    const part = letterMarkup(ch, x, top, scale, startIndex + i, tone, uid);
    x += (LETTERS[ch].w + gap) * scale;
    return part;
  }).join('');
}

// The logo appears on more than one screen. Its gradients need ids of their own per copy: a url(#id)
// that resolves into a hidden screen paints nothing at all.
export const logoSvg = (uid) => `<svg class="logo-svg" viewBox="0 0 720 372" role="img" aria-label="Fort Flurry">
  <defs>
    <linearGradient id="lg-fort-${uid}" gradientUnits="userSpaceOnUse" x1="0" y1="-14" x2="0" y2="114">
      <stop offset="0" stop-color="#ffb07a"/><stop offset=".42" stop-color="#f4674f"/><stop offset="1" stop-color="#d6324a"/>
    </linearGradient>
    <linearGradient id="lg-flurry-${uid}" gradientUnits="userSpaceOnUse" x1="0" y1="-14" x2="0" y2="114">
      <stop offset="0" stop-color="#d8f1ff"/><stop offset=".45" stop-color="#7cc4f5"/><stop offset="1" stop-color="#3a78d6"/>
    </linearGradient>
  </defs>
  ${wordMarkup('FORT', 34, 1.28, 0, 'fort', 360, uid)}
  ${wordMarkup('FLURRY', 222, 0.98, 4, 'flurry', 360, uid)}
</svg>`;

// ---- title scene --------------------------------------------------------------

const pine = (x, y, s, tone = '#6e7cc2') => `<g transform="translate(${x} ${y}) scale(${s})">
  <rect x="-9" y="-6" width="18" height="30" rx="4" fill="#6f5a7c"/>
  <path d="M0-190C14-160 30-140 48-122 34-120 28-118 22-116 42-92 62-72 84-52 62-48 50-48 38-46 58-26 80-8 104 8-40 16-60 14-104 8-80-8-58-26-38-46-50-48-62-48-84-52-62-72-42-92-22-116-28-118-34-120-48-122-30-140-14-160 0-190Z" fill="${tone}"/>
  <path d="M0-190C14-160 30-140 48-122 34-118 18-128 8-120-4-112-14-130-26-120-30-122-40-122-48-122-30-140-14-160 0-190ZM-22-116C-14-108 0-112 10-104 22-96 28-108 42-96 52-84 66-68 84-52 66-50 46-60 34-50 22-40 8-62-8-52-24-44-34-54-46-46-56-50-70-50-84-52-62-72-42-92-22-116Z" fill="#f4f6ff" opacity=".92"/>
</g>`;

const house = (x, y, s, wall, roof, lit) => `<g transform="translate(${x} ${y}) scale(${s})">
  <rect x="34" y="-136" width="24" height="56" rx="4" fill="${roof}"/>
  <rect x="30" y="-142" width="32" height="14" rx="7" fill="#f6f8ff"/>
  <rect x="-70" y="-78" width="140" height="84" rx="8" fill="${wall}"/>
  <path d="M-88-70-4-138Q0-142 4-138L88-70Q90-62 80-62H-80Q-90-62-88-70Z" fill="${roof}"/>
  <path d="M-88-70-4-138Q0-142 4-138L88-70C74-60 62-74 48-66 34-58 24-76 8-68-6-60-18-74-34-66-50-58-62-74-88-70Z" fill="#f7f9ff"/>
  <rect class="win ${lit}" x="-48" y="-50" width="30" height="32" rx="6" fill="#ffd98a"/>
  <rect class="win ${lit}" x="18" y="-50" width="30" height="32" rx="6" fill="#ffc768"/>
  <path d="M-33-50V-18M-48-34H-18M33-50V-18M18-34H48" stroke="${wall}" stroke-width="3"/>
  <circle class="smoke s1" cx="46" cy="-156" r="9"/><circle class="smoke s2" cx="46" cy="-156" r="11"/><circle class="smoke s3" cx="46" cy="-156" r="8"/>
</g>`;

const block = (x, y, w = 92, h = 58, tone = '#dbe3f6') => `<g transform="translate(${x} ${y})">
  <rect width="${w}" height="${h}" rx="15" fill="${tone}"/>
  <rect x="2" width="${w - 4}" height="${h * 0.54}" rx="13" fill="#fdfeff"/>
  <path d="M${w * 0.2} ${h * 0.7}q${w * 0.14} 6 ${w * 0.3} 0" stroke="#c6cfee" stroke-width="3" fill="none" stroke-linecap="round"/>
</g>`;

const kid = (x, y, s, { coat, scarf, hat, skin, flip = false, arm = 'down', cls = '' }) => {
  const armPath = arm === 'up'
    ? `<path d="M22-52C34-62 44-78 48-94" stroke="${coat}" stroke-width="17" fill="none" stroke-linecap="round"/><circle cx="49" cy="-100" r="11" fill="${scarf}"/>`
    : arm === 'throw'
      ? `<path d="M-20-54C-34-66-44-84-40-102" stroke="${coat}" stroke-width="17" fill="none" stroke-linecap="round"/><circle cx="-39" cy="-109" r="11" fill="${scarf}"/><circle cx="-39" cy="-126" r="11" fill="#fff"/>`
      : `<path d="M24-52C34-44 38-34 38-24" stroke="${coat}" stroke-width="17" fill="none" stroke-linecap="round"/><circle cx="38" cy="-20" r="10.5" fill="${scarf}"/>`;
  return `<g class="kid ${cls}" transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
  <ellipse cx="0" cy="3" rx="40" ry="10" fill="#aeb6e6" opacity=".7"/>
  <rect x="-24" y="-18" width="21" height="20" rx="9" fill="#5b4b73"/>
  <rect x="3" y="-18" width="21" height="20" rx="9" fill="#5b4b73"/>
  <path d="M-32-12C-38-52-24-70 0-70 24-70 38-52 32-12 20-6-20-6-32-12Z" fill="${coat}"/>
  <path d="M-30-30C-14-24 14-24 30-30" stroke="#000" stroke-opacity=".09" stroke-width="5" fill="none"/>
  ${armPath}
  <path d="M-22-60C-34-52-46-46-56-48-50-38-34-38-20-46Z" fill="${scarf}"/>
  <path d="M-25-68C-10-58 10-58 25-68L26-54C10-44-10-44-26-54Z" fill="${scarf}"/>
  <circle cx="0" cy="-92" r="30" fill="${skin}"/>
  <circle cx="-18" cy="-82" r="6" fill="#f29c9c" opacity=".55"/><circle cx="18" cy="-82" r="6" fill="#f29c9c" opacity=".55"/>
  <circle cx="-10" cy="-91" r="3.6" fill="#2f3160"/><circle cx="10" cy="-91" r="3.6" fill="#2f3160"/>
  <path d="M-6-81Q0-75 6-81" stroke="#2f3160" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <path d="M-32-98C-34-136 34-136 32-98 16-108-16-108-32-98Z" fill="${hat}"/>
  <path d="M-33-98C-16-110 16-110 33-98L34-90C16-100-16-100-34-90Z" fill="#fff" opacity=".85"/>
  <circle cx="0" cy="-134" r="11.5" fill="#fff"/>
</g>`;
};

const star = (x, y, r) => {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r * 0.46 : r;
    pts.push(`${(x + Math.cos(a) * rad).toFixed(1)} ${(y + Math.sin(a) * rad).toFixed(1)}`);
  }
  return `<path d="M${pts.join('L')}Z" fill="#f6c64a" stroke="#f6c64a" stroke-width="2" stroke-linejoin="round"/>`;
};

const COLONEL = `<g id="colonel" class="colonel" transform="translate(1060 668)">
  <g class="colonel-sway">
    <path class="colonel-arm" d="M52-198C86-214 118-250 92-300" stroke="#7a5a48" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M100-286l18-14M92-300l-4-22" stroke="#7a5a48" stroke-width="7" stroke-linecap="round"/>
    <path d="M-54-196C-86-190-120-176-150-182" stroke="#7a5a48" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M-124-182l-16-20M-132-180l-10 18" stroke="#7a5a48" stroke-width="7" stroke-linecap="round"/>
    <circle cx="0" cy="-74" r="92" fill="url(#ball)"/>
    <circle cx="0" cy="-196" r="68" fill="url(#ball)"/>
    <circle cx="0" cy="-288" r="52" fill="url(#ball)"/>
    <circle cx="0" cy="-214" r="7" fill="#3a3a70"/><circle cx="2" cy="-186" r="7" fill="#3a3a70"/><circle cx="0" cy="-158" r="7" fill="#3a3a70"/>
    <g id="colonel-face">
      <ellipse cx="-20" cy="-300" rx="8" ry="9.5" fill="#34356e"/><ellipse cx="20" cy="-300" rx="8" ry="9.5" fill="#34356e"/>
      <circle cx="-17" cy="-303" r="2.4" fill="#fff" opacity=".9"/><circle cx="23" cy="-303" r="2.4" fill="#fff" opacity=".9"/>
      <path d="M-4-288Q-86-268-92-262-40-262 2-272Z" fill="#f08a24"/>
      <path d="M-4-288Q-50-276-70-268" stroke="#ffb45e" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M-24-262q24 16 48 0" stroke="#34356e" stroke-width="5" stroke-dasharray="0.1 11" stroke-linecap="round" fill="none"/>
    </g>
    <path d="M-60-322C-62-332-58-334-50-334L50-334C58-334 62-332 60-322 40-308-40-308-60-322Z" fill="#7f89c6"/>
    <path d="M-46-330-38-398C-20-408 20-408 38-398L46-330C20-322-20-322-46-330Z" fill="#9aa4d8"/>
    <path d="M-38-398C-20-408 20-408 38-398 20-388-20-388-38-398Z" fill="#c3cbef"/>
    <path d="M-30-392-36-336" stroke="#fff" stroke-opacity=".4" stroke-width="7" stroke-linecap="round"/>
    ${star(-18, -362, 12)}${star(18, -362, 12)}${star(0, -340, 9)}
  </g>
</g>`;

const FORT_WALL = [
  block(806, 636), block(900, 620), block(1000, 612), block(1100, 612), block(1200, 620), block(1294, 636),
  block(852, 690), block(948, 680), block(1048, 676), block(1148, 680), block(1246, 690),
].join('');

const FLAG = `<g transform="translate(838 636)">
  <rect x="-5" y="-150" width="10" height="156" rx="5" fill="#8f6a52"/>
  <circle cx="0" cy="-156" r="9" fill="#f6c64a"/>
  <path class="flag" d="M5-144C44-158 72-128 118-142V-82C72-68 44-98 5-84Z" fill="#d6404e"/>
  <path class="flag" d="M46-124c-10 2-12 24 2 28 10 2 20 0 24-6 2-4-2-8-6-6 2-6 2-16-4-16-2-6-10-6-16 0Z" fill="#fff4e3"/>
</g>`;

const MARCHERS = [0, 1, 2, 3, 4, 5].map((i) => {
  const coats = ['#7a6bd1', '#6b7a8f', '#7a6bd1', '#3f8fc4', '#6b7a8f', '#7a6bd1'];
  return `<g transform="translate(${i * 54} ${i % 2 ? 3 : 0})"><g class="marcher" style="--i:${i}">${kid(0, 0, 0.34, { coat: coats[i], scarf: '#e7c64a', hat: '#5a5fa8', skin: '#f2c6a0' })}</g></g>`;
}).join('');

export const SCENE_SVG = `<svg class="scene-svg" viewBox="0 0 1600 900" aria-hidden="true">
  <defs>
    <radialGradient id="sun" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#fff2c4" stop-opacity=".95"/><stop offset=".22" stop-color="#ffd99a" stop-opacity=".72"/>
      <stop offset=".6" stop-color="#ffc7a0" stop-opacity=".2"/><stop offset="1" stop-color="#ffc7a0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ball" cx=".38" cy=".3" r=".8">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".62" stop-color="#eff3fd"/><stop offset="1" stop-color="#c4cdf0"/>
    </radialGradient>
    <linearGradient id="snow-mid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f2fb"/><stop offset="1" stop-color="#d9def5"/>
    </linearGradient>
    <linearGradient id="snow-near" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e6ebfa"/>
    </linearGradient>
    <linearGradient id="ridge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b6aee3"/><stop offset="1" stop-color="#c9c6ee"/>
    </linearGradient>
  </defs>
  <circle class="sun" cx="1262" cy="500" r="430" fill="url(#sun)"/>
  <circle cx="1262" cy="500" r="74" fill="#fff0c2"/>
  <path d="M0 520C160 450 320 500 500 462S860 410 1060 482 1400 450 1600 500V900H0Z" fill="#a39edd" opacity=".75"/>
  ${pine(70, 540, 0.8, '#8a8fd0')}${pine(640, 490, 0.62, '#8a8fd0')}${pine(1520, 520, 0.72, '#8a8fd0')}
  <path d="M0 590C200 530 420 584 640 556S1090 524 1310 570 1500 552 1600 572V900H0Z" fill="url(#ridge)"/>
  ${house(190, 590, 1, '#8b86cc', '#6d6ab4', 'w1')}${house(392, 576, 0.84, '#a08ccb', '#7b70b6', 'w2')}${house(560, 566, 0.72, '#8796d2', '#6a78bb', 'w3')}
  ${house(1442, 584, 0.86, '#a08ccb', '#7b70b6', 'w2')}
  ${pine(286, 590, 0.74, '#6e7cc2')}${pine(486, 572, 0.6, '#6e7cc2')}${pine(1566, 586, 0.82, '#6e7cc2')}
  <g class="march-track" transform="translate(1160 576)">${MARCHERS}</g>
  <path d="M0 650C260 606 520 642 800 620S1330 596 1600 640V900H0Z" fill="url(#snow-mid)"/>
  <path d="M0 700C240 668 420 700 640 684" stroke="#c9cff0" stroke-width="10" stroke-linecap="round" fill="none" opacity=".5"/>
  ${COLONEL}
  ${FLAG}
  ${FORT_WALL}
  ${kid(930, 622, 0.8, { coat: '#3f8fc4', scarf: '#f2d64b', hat: '#3fa66a', skin: '#d9a273', arm: 'down', cls: 'peek' })}
  ${kid(1274, 622, 0.86, { coat: '#d86fa8', scarf: '#2d7fd3', hat: '#7a6bd1', skin: '#fbe0cf', arm: 'up', flip: true, cls: 'cheer' })}
  ${block(858, 742, 104, 62, '#d3dcf3')}${block(1160, 742, 104, 62, '#d3dcf3')}${block(1010, 734, 104, 62, '#d3dcf3')}
  <path d="M0 790C210 742 470 790 720 766S1240 730 1600 786V900H0Z" fill="url(#snow-near)"/>
  <path d="M0 836C260 800 520 842 800 822S1330 800 1600 838V900H0Z" fill="#fff"/>
  <path d="M120 812q70 16 150 2M980 800q90 18 190 4M1330 812q60 12 130 2" stroke="#cfd6f2" stroke-width="7" stroke-linecap="round" fill="none"/>
  <g transform="translate(1440 800) rotate(4)">
    <rect x="-5" y="-92" width="10" height="96" rx="5" fill="#8f6a52"/>
    <path d="M-24-112H24L14-92H-14Z" fill="#8f6a52"/>
    <path d="M-20 0C-22 28 22 28 20 0L14-16H-14Z" fill="#9aa4d8"/>
  </g>
  <g transform="translate(236 830) rotate(-3)">
    <path d="M-92-10H88C110-10 118-34 104-46" stroke="#d6404e" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M-74-26H70M-54-26V-10M50-26V-10" stroke="#a9722f" stroke-width="10" stroke-linecap="round"/>
  </g>
  ${kid(800, 846, 1.2, { coat: '#d9534f', scarf: '#f2d64b', hat: '#3f8fc4', skin: '#f2c6a0', arm: 'throw', cls: 'thrower' })}
  <g id="scene-fx"></g>
  <g class="arc arc-a"><g class="arc-y"><circle class="fly" r="15" fill="#fff"/><circle r="15" cx="-3" cy="3" fill="#dfe6f7" opacity=".7"/></g></g>
  <g class="arc arc-b"><g class="arc-y"><circle class="fly" r="13" fill="#fff"/><circle r="13" cx="3" cy="3" fill="#dfe6f7" opacity=".7"/></g></g>
</svg>`;

// ---- interface icons -------------------------------------------------------------

const icon = (body, vb = '0 0 24 24') => `<svg class="ico" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const round = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

export const ICON = Object.freeze({
  hammer: icon(`<path d="M14 3l7 7-2.6 2.6-2-2-8.7 8.7a2.1 2.1 0 0 1-3-3l8.7-8.7-2-2z" fill="currentColor"/>`),
  menu: icon(`<path d="M5 7h14M5 12h14M5 17h14" ${round} stroke-width="3"/>`),
  close: icon(`<path d="M6 6l12 12M18 6L6 18" ${round} stroke-width="3.2"/>`),
  check: icon(`<path d="M5 13l5 5 9-11" ${round} stroke-width="3.4"/>`),
  plus: icon(`<path d="M12 5v14M5 12h14" ${round} stroke-width="3.4"/>`),
  back: icon(`<path d="M14.5 5.5L8 12l6.5 6.5" ${round} stroke-width="3.4"/>`),
  dice: icon(`<rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="currentColor"/><g fill="#fff"><circle cx="8.5" cy="8.5" r="1.8"/><circle cx="15.5" cy="15.5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="15.5" cy="8.5" r="1.8"/><circle cx="8.5" cy="15.5" r="1.8"/></g>`),
  link: icon(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" ${round} stroke-width="2.6"/>`),
  chat: icon(`<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.6 3.6c-.5.4-1.2 0-1.2-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor"/>`),
  crown: icon(`<path d="M3.5 18.5l-1-11 5.2 4L12 4.5l4.3 7 5.2-4-1 11z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`),
  sound: icon(`<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" ${round} stroke-width="2.4"/>`),
  mute: icon(`<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" ${round} stroke-width="2.6"/>`),
  gear: icon(`<path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zm8.6 5.5-2-.3a6.8 6.8 0 0 1-.6 1.5l1.2 1.7-2 2-1.7-1.2c-.5.3-1 .5-1.5.6l-.3 2h-3.4l-.3-2a6.8 6.8 0 0 1-1.5-.6L6.8 18.600l-2-2 1.2-1.7a6.800 6.800 0 0 1-.6-1.500l-2-.3v-3.400l2-.3c.1-.5.3-1 .6-1.500L4.800 6.200l2-2 1.700 1.200c.5-.3 1-.5 1.500-.6l.3-2h3.400l.3 2c.5.1 1 .3 1.500.6l1.700-1.200 2 2-1.200 1.700c.3.5.5 1 .6 1.500l2 .3z" fill="currentColor" fill-rule="evenodd"/>`),
  book: icon(`<path d="M5 4.500h6a2 2 0 0 1 1 .3 2 2 0 0 1 1-.3h6v14h-6.500a1.500 1.500 0 0 0-.5.2 1.500 1.500 0 0 0-.5-.2H5z" fill="currentColor"/><path d="M12 5.500v12.500" stroke="#fff" stroke-opacity=".6" stroke-width="1.800"/>`),
  friends: icon(`<circle cx="8.500" cy="8" r="3.600" fill="currentColor"/><circle cx="16" cy="9" r="3" fill="currentColor"/><path d="M2 19.500c0-4 3-6 6.500-6s6.500 2 6.500 6zM16.500 19.500c0-2.400-.8-4.200-2.200-5.400 3.800-.8 7.700 1 7.700 5.400z" fill="currentColor"/>`),
  key: icon(`<circle cx="8" cy="15" r="4.800" ${round} stroke-width="2.800"/><path d="M11.500 11.500L20 3M16 7l3 3" ${round} stroke-width="2.800"/>`),
  snowball: icon(`<circle cx="12" cy="12" r="8.500" fill="currentColor"/><circle cx="9" cy="9" r="2" fill="#fff" opacity=".7"/>`),
  bolt: icon(`<path d="M3 15c3 4 7 4 11 2l6-3-3-3-5 2c-3 1-6 1-9 2z" fill="currentColor"/><path d="M4 9l3 1M8 6l2 2" ${round} stroke-width="2.600"/>`),
  arc: icon(`<path d="M3 19C5 8 15 5 21 15" ${round} stroke-width="3" stroke-dasharray="1 5"/><circle cx="20.500" cy="16.500" r="3" fill="currentColor"/>`),
  shout: icon(`<path d="M3 10v4l11 5V5zM14 8.500v7" fill="currentColor"/><path d="M17 9a4 4 0 0 1 0 6M6.500 15.500l1 4.500h3l-.8-3.500" fill="currentColor"/>`),
  phone: icon(`<rect x="7" y="2.500" width="10" height="19" rx="2.800" ${round} stroke-width="2.400"/><path d="M11 18.500h2" ${round} stroke-width="2.400"/>`),
});

