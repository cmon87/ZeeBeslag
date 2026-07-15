// src/game/menu.js
//
// M4.9: Menu is een dunne schil geworden. De eigen hamburger, lade en scrim zijn weg; alles
// zit nu in het hoofdmenu (src/ui/devPanel.js). Deze klasse blijft bestaan zodat main.js,
// matchDirector (menu.refresh) en Telemetry.bind zonder wijziging blijven werken: de cfg die
// hier binnenkomt wordt 1-op-1 doorgegeven aan DevPanel.gameConfig().

import { DevPanel } from '../ui/devPanel.js';

export class Menu {
  constructor(cfg) {
    this.cfg = cfg;
    DevPanel.gameConfig(cfg);
  }
  refresh()  { DevPanel.refresh(); }
  setWarn(n) { DevPanel.setWarn(n); }
  show()     { DevPanel.open(); }
  close()    { DevPanel.close(); }
  toggle()   { DevPanel.toggleOpen(); }
  dispose()  {}
}
