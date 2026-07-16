import { MatchDirector } from './matchDirector.js';
import { pushLog } from '../core/log.js';

export class LevelMatchDirector extends MatchDirector {
  finishMission(success, title, sub) {
    if (this.gameOver || this.state === 'resetting') return false;
    pushLog('GAME', `${title}. ${sub}`, !success);
    this._transition('gameOver', success ? 'missie voltooid' : 'missie gefaald');
    this._freezeCombatNow();
    if (this.refs.missionHud && typeof this.refs.missionHud.announce === 'function') {
      this.refs.missionHud.announce(title, sub, success ? 'success' : 'danger', 8);
    }
    this.showResult(title, success ? '#7ee8b0' : '#ff7a68', sub);
    return true;
  }

  onShipSank() {
    return this.finishMission(false, 'MISSIE GEFAALD', 'Het schip is gezonken.');
  }

  onObjectiveComplete() {
    return this.finishMission(true, 'MISSIE GESLAAGD', 'Alle aangewezen vijandelijke objectieven zijn uitgeschakeld.');
  }
}
