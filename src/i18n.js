/**
 * Language.
 *
 * The English text stays in index.html as the element's own content, and a
 * `data-t` attribute names the key. So the page reads correctly before any
 * script runs, reads correctly if a key is ever missing, and the markup is
 * still the thing you edit when you want to change the English.
 *
 * The strings the script raises — notices, button labels that toggle — live in
 * the table below and are looked up by the same keys.
 *
 * Adding a language means one more block in STRINGS and one more row in LANGS.
 * A key with no translation falls back to English rather than showing a key,
 * which is what makes a half-finished language safe to ship.
 *
 * Release notes are deliberately not here. They grow by a paragraph every time
 * something changes, and a translation of them would be stale within a day of
 * being written; they stay in the language they were written in.
 */
import { $ } from './util.js';

export const LANGS = [
  ['en', 'English'],
  ['de', 'Deutsch'],
];

const STRINGS = {
  de: {
    /* ---- home */
    'step.back':      'Leg dich auf den Rücken.',
    'step.phone':     'Handy mit dem Display nach oben auf den Bauch, am Nabel.',
    'step.sound':     'Ton an, Mitteilungen aus, am besten Kopfhörer.',
    'step.breathe':   'Atme und hör den Wellen zu.',
    'btn.start':      'Start',
    'btn.end':        'Ende',
    'btn.soundon':    'Ton an',
    'btn.soundoff':   'Ton aus',
    'pace.label':     'Wellen zum Mitatmen',
    'n.pace.b':       'Die Wellen am Anfang stehen jetzt auf {0} pro Minute, nach dieser Sitzung. Auf dem Startbildschirm änderbar.',
    'tag.listening':  'hört zu',
    'tag.settling':   'kommt zur Ruhe',
    'tag.demo':       'Demo',
    'cue.breathe':    'Atme',
    'cue.with':       'Atme mit den Wellen',

    /* ---- live readout */
    'read.rate':      'Dein Tempo',
    'read.ratio':     'Ein / aus',
    'read.heart':     'Herz',
    'unit.min':       '/min',
    'hint.lower':     'leg das Handy tiefer auf den Bauch',
    'hint.still':     'lieg einen Moment still',

    /* ---- navigation */
    'nav.recordings': 'Aufnahmen',
    'nav.adjust':     'Einstellen',
    'nav.back':       'Zurück',

    /* ---- adjust */
    'adj.title':      'Einstellen',
    'adj.volume':     'Lautstärke',
    'adj.sens':       'Empfindlichkeit',
    'adj.sens.hint':  'wie bereitwillig es entscheidet, dass du atmest',
    'adj.sound':      'Klang',
    'adj.swell':      'Dünung',
    'adj.swell.hint': 'die Welle, die sich beim Einatmen aufbaut',
    'adj.break':      'Brecher',
    'adj.break.hint': 'der Kamm, oben am Ende des Einatmens',
    'adj.foam':       'Schaum',
    'adj.foam.hint':  'das Zischen, das durch das Ausatmen abläuft',
    'adj.spray':      'Gischt',
    'adj.spray.hint': 'ein schmales Band, das über das Feld zieht',
    'adj.under':      'Sog',
    'adj.under.hint': 'der tiefe Zug am Grund des Atems',
    'adj.bright':     'Helligkeit',
    'adj.bright.hint':'dunkel und nah, oder offen und luftig',
    'adj.space':      'Raum',
    'adj.space.hint': 'eng und nah, oder weit und offen',
    'adj.reset':      'Klangeinstellungen',
    'adj.reset.hint': 'sie bleiben auf diesem Handy gespeichert',
    'adj.reset.btn':  'Zurücksetzen',
    'adj.lang':       'Sprache',
    'adj.try':        'Ausprobieren',
    'adj.try.note':   'standardmäßig aus, und ihrer selbst noch nicht sicher',
    'adj.heard':      'Zeigen, was es hört',
    'adj.heard.hint': 'schattiert die Kurve dort, wo es dich als haltend liest',
    'adj.dim':        'Bildschirm abdunkeln',
    'adj.dim.hint':   'dunkelt das Display beim Atmen ab; eine Berührung holt es zurück',
    'adj.depth':      'Kamm folgt der Tiefe',
    'adj.depth.hint': 'die Welle bricht kräftiger nach einem tieferen Atemzug, nicht nach einem längeren',
    'adj.sensor':     'Sensor',
    'adj.lead':       'Mit den Wellen beginnen',
    'adj.lead.hint':  'eine Welle zum Mitatmen für die erste halbe Minute, bis dich die App h\u00f6rt',
    'adj.flip':       'Richtung umkehren',
    'adj.flip.hint':  'nutzen, wenn der Klang beim Einatmen fällt',
    'adj.pulse':      'Herzfrequenz',
    'adj.pulse.hint': 'experimentell: findet oft nichts, und sagt das auch',
    'adj.demo':       'Demo-Modus',
    'adj.demo.hint':  'simuliertes Atmen, kein Sensor nötig',
    'adj.about':      'Die Bewegungsdaten verlassen dieses Handy nicht. Sitzungen bleiben hier und gehen nirgendwohin, außer du exportierst sie. Ein Entspannungswerkzeug, kein Medizinprodukt.',
    'adj.storage':    'Speicher',
    'adj.storage.open':'Öffnen',
    'adj.clear':      'Alle Aufnahmen löschen',
    'adj.clear.hint': 'lässt sich nicht rückgängig machen',
    'adj.clear.btn':  'Alle löschen',
    'adj.clear.again':'Nochmal tippen',
    'adj.refind':     'Meinen Atem neu finden',

    /* ---- changes */
    'log.title':      'Änderungen',
    'log.get':        'Neueste Version holen',
    'log.hint.plain': 'lädt die Seite neu, am Zwischenspeicher vorbei',
    'log.hint.check': 'fragt nach, ob es etwas Neueres gibt',
    'log.hint.asking':'fragt nach',
    'log.hint.ready': 'eine neue Version ist bereit',
    'log.btn.reload': 'Neu laden',
    'log.btn.check':  'Prüfen',
    'log.btn.install':'Installieren',
    'log.running':    'läuft',

    /* ---- review */
    'rev.session':    'Diese Sitzung',
    'rev.recordings': 'Aufnahmen',
    'rev.recording':  'Aufnahme',
    'rev.cap':        'Der obere Streifen ist die ganze Sitzung: wie tief jeder Atemzug war, und die Linie darin ist dein Tempo. Zieh die Spur darunter mit zwei Fingern auf.',
    'rev.length':     'Dauer',
    'rev.breaths':    'Atemzüge',
    'rev.avg':        'Tempo im Schnitt',
    'rev.slowest':    'Am langsamsten',
    'rev.fastest':    'Am schnellsten',
    'rev.inout':      'Ein / aus',
    'rev.held':       'Still gehalten',
    'rev.longhold':   'Längste Pause',
    'rev.hr':         'Herzschlag',
    'rev.hr.est':     'gesch. /min',
    'rev.export':     'Exportieren',
    'rev.exportall':  'Alle exportieren',
    'rev.delete':     'Diese Aufnahme löschen',
    'rev.delete2':    'Wirklich löschen',
    'rev.none':       'Es wurde nichts aufgenommen, deshalb gibt es hier nichts zu sehen.',
    'n.nodelete':     'Konnte nicht gelöscht werden',
    'n.norec':        'Aufnahme nicht gefunden',
    'rev.noflag.rate':'Diese Aufnahme hat nie einen Rhythmus gefunden, den die App lesen konnte. Deshalb steht hier kein Tempo.',
    'rev.noflag.q':   'Das Signal war fast die ganze Sitzung über unruhig. Die Tempoangaben oben sind ungefähr.',
    'rev.noflag.sig': 'Diese Aufnahme hat keine gespeicherte Kurve, die Ansicht bleibt leer.',
    'rev.noflag.hr':  'In dieser Aufnahme war kein Herzschlag herauszuhören.',
    'rev.empty.head': 'Noch keine Aufnahmen',
    'rev.count.0':    'noch nichts gespeichert',
    'rev.count.1':    '1 Aufnahme gespeichert',
    'rev.count.n':    '{0} Aufnahmen gespeichert',
    'rev.rateunknown':'Tempo unbekannt',

    /* ---- notices */
    'n.newver':       'Eine neue Version ist bereit',
    'n.newver.b':     'Öffne Änderungen unten auf dem Startbildschirm, um sie zu installieren.',
    'n.uptodate':     'Aktuell',
    'n.uptodate.b':   'Das ist die neueste Version. Es gibt nichts zu installieren.',
    'n.nocheck':      'Prüfen nicht möglich',
    'n.nocheck.b':    'Keine Antwort aus dem Netz. Die App funktioniert auch offline weiter.',
    'n.updfail':      'Update nicht abgeschlossen',
    'n.updfail.b':    'Eine neue Version wurde gefunden, ließ sich aber nicht speichern. An dem, was läuft, ändert sich nichts. Versuch es gleich noch einmal.',
    'n.nosound':      'Kein Ton',
    'n.nosound.b':    'Dieser Browser hat den Ton blockiert. Lade die Seite neu und tippe erneut auf Start.',
    'n.denied':       'Bewegungszugriff abgelehnt',
    'n.denied.b':     'Lade die Seite neu, um erneut gefragt zu werden. Erscheint keine Abfrage, lösche die Daten dieser Seite in den Safari-Einstellungen — ein früheres „Nicht erlauben“ wird pro Seite gemerkt.',
    'n.unsupported':  'Kein Bewegungssensor',
    'n.unsupported.b':'Dieses Gerät oder dieser Browser hat keinen Bewegungssensor. Der Demo-Modus unter Einstellen zeigt dir trotzdem, wie es klingt.',
    'n.reqfail':      'Bewegungsanfrage fehlgeschlagen',
    'n.reqfail.tap':  'Der Browser hat das nicht als direkte Berührung gewertet. Lade die Seite neu und tippe als Erstes auf Start, ohne vorher zu scrollen.',
    'n.reqfail.b':    '{0}. Lade neu und versuch es noch einmal, oder nutze den Demo-Modus unter Einstellen.',
    'n.silent':       'Erlaubt, aber still',
    'n.silent.b':     'Der Bewegungszugriff wurde erlaubt, es kommen aber keine Messwerte an. Sperr den Bildschirm und entsperr ihn wieder, oder lade die Seite neu. Falls das hier in einer anderen App läuft, öffne es direkt im Browser.',
    'n.inactive':     'Bewegung nicht aktiv',
    'n.inactive.b':   'Status der Berechtigung: {0}. Lade neu und tippe zuerst auf Start, oder schalte den Demo-Modus unter Einstellen ein.',
    'n.insecure':     'Keine sichere Seite',
    'n.insecure.b':   'Bewegungssensoren brauchen HTTPS. Öffne diese Seite über https:// und es funktioniert.',
    'n.notkept':      'Nicht gespeichert',
    'n.notkept.b':    '{0}. Die Markierung steht auf dem Bildschirm, ist aber weg, sobald du diese Aufnahme verlässt.',
    'n.notrec':       'Nicht aufgenommen',
    'n.notrec.store': 'Dieser Browser lässt breathe nichts speichern, deshalb wurde die Sitzung nicht behalten. Auf dein Atmen hatte das keinen Einfluss. Öffne die Seite direkt im Browser oder verlasse den privaten Modus, wenn du Aufnahmen möchtest.',
    'n.notrec.err':   'Die Sitzung ließ sich nicht speichern ({0}). Auf dein Atmen hatte das keinen Einfluss. Lösche unter Einstellen ältere Aufnahmen.',
    'n.deleted':      'Aufnahmen gelöscht',
    'n.deleted.b':    'Alle Aufnahmen sind von diesem Handy verschwunden.',
    'n.demo':         'Demo-Modus',
    'n.demo.b':       'Simuliertes Atmen. Gut, um den Klang zu prüfen, ohne sich hinzulegen.',
    'n.soundreset':   'Klang zurückgesetzt',
    'n.soundreset.b': 'Die sieben Klangregler stehen wieder dort, wo sie angefangen haben.',
    'n.refind':       'Von vorn',
    'n.refind.b':     'Atme normal weiter. Es findet deinen Atem in ein paar Zügen wieder.',
    'n.notfound':     'Aufnahme nicht gefunden',
    'n.notfound.b':   'Diese Aufnahme ist nicht mehr auf dem Handy. Öffne Aufnahmen für die, die noch da sind.',
    'n.nodelete':     'Löschen nicht möglich',
    'n.nodelete.b':   '{0}. Versuch es noch einmal über Aufnahmen.',
    'n.noexport':     'Nichts zu exportieren',
    'n.noexport.b':   'Es ist keine Aufnahme auf dem Bildschirm, die geschrieben werden könnte.',
    'n.noexport.none':'Auf diesem Handy sind noch keine Aufnahmen.',
    'n.exportfail':   'Export fehlgeschlagen',
    'n.exportfail.read':'Diese Aufnahme ließ sich nicht vom Handy lesen.',
    'n.exportfail.b': '{0}. Exportiere die Aufnahmen einzeln.',
    'n.exportfail.blob':'Dieser Browser wollte die Datei nicht bauen. Versuch einen anderen Browser.',
    'n.exportfail.dl':'Dieser Browser hat den Download blockiert. Öffne die Seite direkt in Safari oder Chrome und versuch es noch einmal.',
    'n.storeblocked': 'Speicher nicht verfügbar',
    'n.storeblocked.b':'Dieser Browser blockiert lokalen Speicher, deshalb können Sitzungen nicht zwischen Besuchen behalten werden. Eine gerade beendete Sitzung steht noch auf dem Abschlussbildschirm, und du kannst sie von dort exportieren, bevor du ihn verlässt.',
    'n.storeread':    'Aufnahmen nicht lesbar',
    'n.storeread.b':  '{0}. Schließe andere Tabs dieser Seite und öffne Aufnahmen erneut.',
    'n.storeunavail': 'Speicher nicht verfügbar',
  }
};

let lang = 'en';

/** The stored choice, else the phone's language if we speak it, else English. */
export function pickLang(saved){
  if(saved && (saved === 'en' || STRINGS[saved])) return saved;
  let nav = '';
  try{ nav = (navigator.language || '').slice(0,2).toLowerCase(); }catch(e){}
  return STRINGS[nav] ? nav : 'en';
}

export function getLang(){ return lang; }

export function setLang(code){
  lang = (code === 'en' || STRINGS[code]) ? code : 'en';
  try{ document.documentElement.setAttribute('lang', lang); }catch(e){}
  return lang;
}

/**
 * @param key   a key in STRINGS
 * @param vals  substituted for {0}, {1}, … in order
 * @param fallback  the English, when the caller has no markup to fall back to
 */
export function t(key, vals, fallback){
  const table = STRINGS[lang];
  let s = (table && table[key]);
  if(s === undefined) s = (fallback !== undefined ? fallback : key);
  if(vals && vals.length){
    for(let i=0;i<vals.length;i++) s = s.split('{'+i+'}').join(String(vals[i]));
  }
  return s;
}

/** Localised decimal. German writes 3,4 and it looks wrong not to. */
export function n(v, dp){
  const s = Number(v).toFixed(dp === undefined ? 1 : dp);
  return lang === 'en' ? s : s.replace('.', ',');
}

/**
 * Walk the markup and swap in the current language. Elements carry their
 * English as their own content, so this is a no-op for English and cannot
 * blank an element whose key is missing.
 */
export function apply(root){
  const host = root || document;
  const table = STRINGS[lang] || {};
  for(const el of host.querySelectorAll('[data-t]')){
    // The markup is the English, captured once before anything replaces it.
    if(el.dataset.tEn === undefined) el.dataset.tEn = el.textContent;
    const s = table[el.getAttribute('data-t')];
    el.textContent = (s !== undefined) ? s : el.dataset.tEn;
  }
  for(const el of host.querySelectorAll('[data-t-aria]')){
    if(el.dataset.tAriaEn === undefined) el.dataset.tAriaEn = el.getAttribute('aria-label') || '';
    const s = table[el.getAttribute('data-t-aria')];
    el.setAttribute('aria-label', (s !== undefined) ? s : el.dataset.tAriaEn);
  }
}
