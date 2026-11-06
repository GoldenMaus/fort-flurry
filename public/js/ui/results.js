// End of a match. Who sees Play Again follows hostId live, because the host can change while this
// screen is open (SPEC 11.2).
import { MODE, TEAM_NAME } from '../../shared/schema.js';
import { el } from './dom.js';
import { AWARD_COPY } from './copy.js';
import { kidCanvas } from './kidview.js';
import { statRows } from './scoreboard.js';
import { ChatPanel } from './chat.js';
import { menuButton } from './title.js';

const MAX_HEROES = 6;

function headline(result, meId, names) {
  const won = result.winners.includes(meId);
  if (result.mode === MODE.SIEGE) return won ? 'You held the block!' : 'Colonel Carrot took a tumble';
  if (result.mode === MODE.FORTWARS) {
    if (won) return 'Your fort is still standing!';
    return result.winnerTeam === null ? 'What a snowy mess!' : `${TEAM_NAME[result.winnerTeam]} rule the block`;
  }
  if (won) return result.winners.length > 1 ? 'A shared win!' : 'Top of the snow pile!';
  const first = names.get(result.winners[0]);
  return first ? `${first} wins!` : 'That was close!';
}

export class ResultsScreen {
  constructor(ui) {
    this.ui = ui;
    this.result = null;
    this.heroes = el('div', { class: 'results-heroes', 'aria-hidden': 'true' });
    this.title = el('h2', { class: 'results-title', id: 'results-title' });
    this.summary = el('p', { class: 'results-sub', id: 'results-summary' });
    this.awards = el('div', { class: 'awards' });
    this.stats = el('div', { class: 'results-stats panel' });
    this.chat = new ChatPanel(ui, ui.chatLog);
    this.againBtn = menuButton('Play Again', { tone: 'red', size: 'btn-xl', id: 'btn-play-again', on: () => ui.emit('playAgain') });
    this.lobbyBtn = menuButton('Lobby', { tone: 'blue', id: 'btn-to-lobby', on: () => ui.emit('toLobby') });
    this.leaveBtn = menuButton('Leave', { tone: 'ghost', iconName: 'back', id: 'btn-results-leave', on: () => ui.confirmLeave() });
    this.wait = el('p', { class: 'results-wait', id: 'results-wait' });
    this.grid = el('div', { class: 'results-grid' }, this.stats, this.chat.root);
    this.root = el('section', { class: 'screen screen-results', dataset: { screen: 'results' } },
      el('div', { class: 'results-flakes', 'aria-hidden': 'true' }),
      el('div', { class: 'results-col' },
        el('header', { class: 'results-head' }, this.heroes, this.title, this.summary),
        this.awards,
        this.grid,
        el('footer', { class: 'results-foot' }, this.wait, this.againBtn, this.lobbyBtn, this.leaveBtn)));
  }

  playerInfo() {
    const map = new Map();
    for (const [id, p] of this.ui.session?.view?.players ?? []) map.set(id, p);
    for (const p of this.ui.session?.lobby?.players ?? []) if (!map.has(p.id)) map.set(p.id, p);
    return map;
  }

  enter({ result }) {
    this.result = result;
    const session = this.ui.session;
    const info = this.playerInfo();
    const names = new Map([...info].map(([id, p]) => [id, p.name]));
    const won = result.winners.includes(session.me);
    this.root.classList.toggle('won', won);
    this.root.classList.toggle('lost', !won);
    this.title.textContent = headline(result, session.me, names);
    this.summary.textContent = result.summary ?? '';

    const team = (who) => (result.mode === MODE.FORTWARS ? who.team : undefined);
    this.heroes.replaceChildren(...result.winners.slice(0, MAX_HEROES).flatMap((id, i) => {
      const who = info.get(id);
      if (!who?.look) return [];
      const kid = kidCanvas(who.look, { w: 92, h: 100, team: team(who), pose: 'cheer', frame: i % 2 });
      kid.style.setProperty('--i', String(i));
      return [kid];
    }));

    this.awards.replaceChildren(...result.players.filter((p) => p.award && AWARD_COPY[p.award]).map((p) => {
      const copy = AWARD_COPY[p.award];
      const who = info.get(p.id);
      return el('article', { class: `award award-${p.award}` },
        who?.look ? kidCanvas(who.look, { w: 64, h: 70, team: team(who) }) : null,
        el('h3', { class: 'award-name', text: copy.name }),
        el('p', { class: 'award-who', text: who?.name ?? '?' }),
        el('p', { class: 'award-why', text: copy.why }));
    }));

    const rows = result.players.map((p) => {
      const who = info.get(p.id);
      return { id: p.id, name: who?.name ?? '?', team: who?.team, look: who?.look, ...p.stats };
    });
    this.stats.replaceChildren(statRows(rows, session.me, result.mode === MODE.FORTWARS));
    this.chat.root.hidden = !!this.ui.roomInfo.solo;
    this.grid.classList.toggle('no-chat', !!this.ui.roomInfo.solo);
    this.chat.rebuild();
    this.refreshHost();
  }

  refreshHost() {
    const { session } = this.ui;
    const lobby = session?.lobby;
    const isHost = lobby ? lobby.hostId === session.me : !!session?.isHost;
    const host = lobby?.players.find((p) => p.id === lobby.hostId);
    this.againBtn.hidden = !isHost;
    this.lobbyBtn.hidden = !isHost;
    this.leaveBtn.hidden = isHost;
    this.wait.hidden = isHost;
    this.wait.textContent = `Waiting for ${host?.name ?? 'the host'}...`;
  }

  setLobby() { if (this.result) this.refreshHost(); }
}
