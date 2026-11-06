// Upgrade cards. They never pause or block: on big screens they sit beside the action, and on small
// ones a pill opens a sheet so they don't cover the ground (SPEC 11.3).
import { CMD } from '../../shared/schema.js';
import { CARD_BY_ID } from '../../shared/cards.js';
import { el, hudBtn } from './dom.js';
import { ICON } from './art.js';
import { iconNode } from './kidview.js';

const PAD_HINT = ['D-pad left', 'D-pad up', 'D-pad right'];

export class CardPanel {
  constructor(ui) {
    this.ui = ui;
    this.key = '';
    this.pickedKey = '';
    this.list = el('div', { class: 'cards-list' });
    this.closeBtn = hudBtn({
      class: 'cards-close',
      'aria-label': 'Close cards',
      trustedHtml: ICON.close,
      on: { click: () => this.setSheet(false) },
    });
    this.panel = el('div', { class: 'cards-panel panel-dark', role: 'group', 'aria-label': 'Pick a card' },
      el('div', { class: 'cards-head' }, el('span', { class: 'cards-title', text: 'Pick a card' }), this.closeBtn),
      this.list);
    this.pill = hudBtn({
      class: 'cards-pill',
      id: 'cards-pill',
      text: 'Pick a card',
      on: { click: () => this.setSheet(true) },
    });
    this.root = el('div', { class: 'cardbox', hidden: true }, this.pill, this.panel);
  }

  setSheet(on) { this.root.classList.toggle('sheet-open', on); }

  pick(i) {
    const session = this.ui.session;
    if (!session?.offer || this.pickedKey === this.key) return;
    session.cmd(CMD.CARD, { i });
    this.pickedKey = this.key;
    this.setSheet(false);
    this.root.hidden = true;
  }

  render(offer, owned) {
    this.list.replaceChildren(...offer.map((id, i) => {
      const card = CARD_BY_ID[id];
      const held = owned.filter((c) => c === id).length;
      return hudBtn({
        class: 'card',
        dataset: { card: id, i: String(i) },
        on: { click: () => this.pick(i) },
      },
      el('span', { class: 'card-art' }, iconNode(`card:${id}`, 52)),
      el('span', { class: 'card-copy' },
        el('span', { class: 'card-name', text: card?.name ?? id }),
        el('span', { class: 'card-blurb', text: card?.blurb ?? '' })),
      held ? el('span', { class: 'card-held', text: `x${held}` }) : null,
      el('span', { class: 'card-pad', text: PAD_HINT[i] }));
    }));
  }

  update(session, view) {
    const offer = session?.offer ?? null;
    if (!offer) {
      if (!this.root.hidden) this.root.hidden = true;
      this.setSheet(false);
      this.key = '';
      this.pickedKey = '';
      return;
    }
    const key = offer.join('|');
    if (key !== this.key) {
      this.key = key;
      this.pickedKey = '';
      this.render(offer, view?.meta?.cards?.[session.me] ?? []);
    }
    const hide = this.pickedKey === key;
    if (this.root.hidden !== hide) this.root.hidden = hide;
  }
}
