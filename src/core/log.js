// src/core/log.js
//
// Centrale logbuffer. Eén bron van waarheid voor de perf-ribbon, de warning-toast en de
// console (devPanel). Elk logbericht is:
//
//   { t, time, tag, msg, level, isError }
//     t      seconden sinds start (getal)          -> devPanel LOG tab: x.t.toFixed(1)
//     time   'HH:MM:SS'                             -> export en toast
//     tag    korte bron, bijv. 'GAME', 'GLB'
//     msg    tekst
//     level  'info' | 'warn' | 'error'             -> devPanel filters en kleuren
//     isError  true bij level 'error'              -> back-compat
//
// BELANGRIJK: schrijven naar de console gebeurt via VASTGELEGDE native referenties (NATIVE).
// Dat breekt de lus die eerder bij elke fout een stack-overflow gaf: een gewikkelde
// console.error die pushLog aanriep, die weer console.error aanriep, enzovoort. pushLog raakt
// de globale console nooit meer aan, alleen de echte native.

const T0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

const NATIVE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export const logHistory = [];
const MAX_LOGS = 300;

let warnErrCount = 0;      // aantal warn + error sinds de laatste clear
const listeners = [];      // meerdere abonnees: ribbon, toast, devPanel

export function addLogListener(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}
// Alias voor oudere aanroepen die nog setLogCallback verwachtten.
export function setLogCallback(cb) { return addLogListener(cb); }

function hhmmss(d) { return d.toISOString().split('T')[1].substring(0, 8); }

// tag, msg, isError, en optioneel een expliciet niveau ('info' | 'warn' | 'error').
export function pushLog(tag, msg, isError = false, level = null) {
  const lvl = level || (isError ? 'error' : 'info');
  const entry = {
    t: +((performance.now() - T0) / 1000).toFixed(2),
    time: hhmmss(new Date()),
    tag: String(tag == null ? '?' : tag),
    msg: String(msg == null ? '' : msg),
    level: lvl,
    isError: lvl === 'error',
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_LOGS) logHistory.shift();
  if (lvl !== 'info') warnErrCount++;

  const line = `[${entry.time}] [${entry.tag}] ${entry.msg}`;
  if (lvl === 'error') NATIVE.error(line);
  else if (lvl === 'warn') NATIVE.warn(line);
  else NATIVE.log(line);

  for (const cb of listeners) { try { cb(entry); } catch (_) {} }
  return entry;
}

export function getLogBuffer() { return logHistory; }
export function getLogHistory() { return logHistory; }
export function getWarnCount() { return warnErrCount; }

export function clearBuffer() {
  logHistory.length = 0;
  warnErrCount = 0;
  for (const cb of listeners) { try { cb(null); } catch (_) {} }  // null = gewist
}

// Voor code die de echte console nodig heeft zonder de wrappers.
export const nativeConsole = NATIVE;
