// Who is doing what. Held open with Tab or View, tapped open on touch, and reused on the results screen.
import { MODE, TEAM, TEAM_NAME } from '../../shared/schema.js';
import { TEAM_STYLE } from '../../shared/constants.js';
import { el } from './dom.js';
import { kidCanvas } from './kidview.js';

const COLUMNS = [['hits', 'Hits'], ['freezes', 'Freezes'], ['thaws', 'Thaws'], ['built', 'Built'], ['flakes', 'Flakes']];

const rank = (a, b) => (b.freezes - a.freezes) || (b.hits - a.hits) || (a.name < b.name ? -1 : 1);

export function statRows(rows, meId, showTeams) {
  const header = el('tr', null, el('th', { class: 'st-name', scope: 'col', text: 'Kid' }),
    COLUMNS.map(([, label]) => el('th', { scope: 'col', text: label })));
  const body = [];
  const groups = showTeams
    ? [TEAM.A, TEAM.B].map((team) => ({ team, list: rows.filter((r) => r.team === team) }))
    : [{ team: null, list: rows }];
  for (const { team, list } of groups) {
    if (team !== null) {
      body.push(el('tr', { class: 'st-team', style: { '--team': TEAM_STYLE[team].color } },
        el('th', { colspan: String(COLUMNS.length + 1), scope: 'colgroup', text: TEAM_NAME[team] })));
    }
    for (const row of [...list].sort(rank)) {
      body.push(el('tr', { class: row.id === meId ? 'st-me' : null },
        el('td', { class: 'st-name' },
          row.look ? kidCanvas(row.look, { w: 26, h: 28, team: showTeams ? row.team : undefined }) : null,
          el('span', { class: 'st-who', text: row.name })),
        COLUMNS.map(([key]) => el('td', { text: String(Math.floor(row[key] ?? 0)) }))));
    }
  }
  return el('table', { class: 'stats-table' }, el('thead', null, header), el('tbody', null, body));
}

export function scoreRows(scores, players) {
  return (scores ?? []).map((s) => {
    const p = players?.get(s.id);
    return { ...s, name: p?.name ?? '?', team: p?.team, look: p?.look };
  });
}

export class Scoreboard {
  constructor(ui) {
    this.ui = ui;
    this.open = false;
    this.nextAt = 0;
    this.key = '';
    this.body = el('div', { class: 'score-body' });
    this.root = el('div', { class: 'scoreboard panel', id: 'scoreboard', hidden: true, role: 'status' },
      el('h3', { class: 'panel-title', text: 'Scores' }), this.body);
  }

  setOpen(on) {
    this.open = !!on;
    this.root.hidden = !this.open;
    this.nextAt = 0;
    this.key = '';
  }

  toggle() { this.setOpen(!this.open); }

  update(view, now) {
    if (!this.open || now < this.nextAt || !view?.meta) return;
    this.nextAt = now + 300;
    // Rebuilt only when a number moved, since each row paints a little kid.
    const key = JSON.stringify(view.meta.scores);
    if (key === this.key) return;
    this.key = key;
    const rows = scoreRows(view.meta.scores, view.players);
    this.body.replaceChildren(statRows(rows, this.ui.session?.me, view.mode === MODE.FORTWARS));
  }
}
