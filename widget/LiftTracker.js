// Lift Tracker: small (square) home screen widget for the Scriptable app.
//
// Setup (once):
//   1. Install Scriptable from the App Store, tap +, paste this script, name it "Lift Tracker".
//   2. In the Lifts app: Program › Update Home Screen Widget… (or the link after you finish
//      a workout) › Save to Files › iCloud Drive › Scriptable › Save (choose Replace if asked).
//      No Scriptable folder in Files? Use On My iPhone › Scriptable instead, or make any folder
//      (e.g. iCloud Drive › Lifts), save there, and add it in Scriptable › Settings ›
//      File Bookmarks with the name "Lifts".
//   3. Long-press your home screen › Edit › Add Widget › Scriptable › small › tap it ›
//      Script: Lift Tracker. Tapping the widget opens the app.
//
// The widget shows your next day in the rotation, the rep target, this week's workouts as a
// Monday-to-Sunday strip, and a nudge when it has not been refreshed since your last session.

const APP_URL = 'https://conspiring-lemur.github.io/lift-tracker/';
const FILE_PREFIX = 'lift-tracker-widget';

// Always dark, like Apple's Fitness widgets.
const C = {
  bgTop: new Color('#232326'), bgBottom: new Color('#0b0b0c'),
  label: Color.white(), label2: new Color('#ebebf5', 0.6), label3: new Color('#ebebf5', 0.3),
  blue: new Color('#0a84ff'), green: new Color('#30d158'), orange: new Color('#ff9f0a'),
  dot: new Color('#ebebf5', 0.14),
};

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Reads the newest lift-tracker-widget*.json in the Scriptable folder (iCloud first).
async function loadData() {
  const managers = [];
  try { managers.push(FileManager.iCloud()); } catch (e) { /* iCloud Drive is off */ }
  managers.push(FileManager.local());
  // Optional: a folder picked in Scriptable › Settings › File Bookmarks, named "Lifts".
  const dirs = [];
  for (const fm of managers) {
    try { if (fm.bookmarkExists('Lifts')) dirs.push({ fm, dir: fm.bookmarkedPath('Lifts') }); } catch (e) { /* no bookmark */ }
    dirs.push({ fm, dir: fm.documentsDirectory() });
  }
  let best = null;
  for (const { fm, dir } of dirs) {
    let names = [];
    try { names = fm.listContents(dir); } catch (e) { continue; }
    for (const name of names) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.json')) continue;
      const path = fm.joinPath(dir, name);
      const mod = fm.modificationDate(path) || new Date(0);
      if (!best || mod > best.mod) best = { fm, path, mod };
    }
  }
  if (!best) return null;
  try {
    if (best.fm.isFileStoredIniCloud(best.path) && !best.fm.isFileDownloaded(best.path)) {
      await best.fm.downloadFileFromiCloud(best.path);
    }
    const data = JSON.parse(best.fm.readString(best.path));
    return data && data.app === 'lift-tracker' ? data : null;
  } catch (e) {
    return null;
  }
}

// Next day after the most recent workout, the same rule the app uses.
function nextDay(data) {
  const rot = data.rotation || [];
  const last = (data.workouts || [])[0];
  if (!last || !rot.length) return data.next?.name || rot[0] || '';
  const i = rot.indexOf(last.day);
  return i < 0 ? data.next?.name || rot[0] : rot[(i + 1) % rot.length];
}

function weekStrip(doneDates) {
  const W = 300, H = 60;
  const dc = new DrawContext();
  dc.size = new Size(W, H);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const col = W / 7;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const cx = col * i + col / 2;
    dc.setFont(Font.semiboldSystemFont(17));
    dc.setTextAlignedCenter();
    dc.setTextColor(i === dow ? C.label : C.label3);
    dc.drawTextInRect(letters[i], new Rect(cx - 16, 0, 32, 22));
    const r = new Rect(cx - 13, 28, 26, 26);
    const done = doneDates.has(isoDay(d));
    const path = new Path();
    path.addEllipse(r);
    dc.addPath(path);
    dc.setFillColor(done ? C.green : C.dot);
    dc.fillPath();
    if (i === dow && !done) {
      const ring = new Path();
      ring.addEllipse(new Rect(r.x + 1.5, r.y + 1.5, r.width - 3, r.height - 3));
      dc.addPath(ring);
      dc.setStrokeColor(C.label2);
      dc.setLineWidth(3);
      dc.strokePath();
    }
  }
  return dc.getImage();
}

function baseWidget(url) {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [C.bgTop, C.bgBottom];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 14, 12, 14);
  w.url = url || APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

function header(w, text, color) {
  const row = w.addStack();
  row.centerAlignContent();
  const sym = SFSymbol.named('dumbbell.fill');
  sym.applyFont(Font.boldSystemFont(12));
  const img = row.addImage(sym.image);
  img.imageSize = new Size(17, 13);
  img.tintColor = color;
  row.addSpacer(5);
  const t = row.addText(text);
  t.font = Font.semiboldSystemFont(11);
  t.textColor = color;
  row.addSpacer();
}

function emptyWidget() {
  const w = baseWidget();
  header(w, 'LIFTS', C.blue);
  w.addSpacer();
  const t = w.addText('Connect your workouts');
  t.font = Font.boldRoundedSystemFont(17);
  t.textColor = C.label;
  t.minimumScaleFactor = 0.7;
  w.addSpacer(4);
  const s = w.addText('In Lifts, tap Program › Update Home Screen Widget, then save to Scriptable.');
  s.font = Font.systemFont(11);
  s.textColor = C.label2;
  s.minimumScaleFactor = 0.8;
  return w;
}

function buildWidget(data) {
  const w = baseWidget(data.url);
  const workouts = data.workouts || [];
  const day = nextDay(data);

  header(w, 'UP NEXT', C.blue);
  w.addSpacer(6);

  const title = w.addText(`${day} Day`);
  title.font = Font.boldRoundedSystemFont(26);
  title.textColor = C.label;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.55;

  const target = w.addText(`${data.next?.target || ''} reps`);
  target.font = Font.mediumSystemFont(13);
  target.textColor = C.label2;
  target.lineLimit = 1;

  w.addSpacer();

  const dates = new Set(workouts.map((x) => x.date));
  const strip = w.addImage(weekStrip(dates));
  strip.imageSize = new Size(142, 28);
  strip.centerAlignImage();

  w.addSpacer(6);

  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const thisWeek = workouts.filter((x) => x.date >= isoDay(monday)).length;
  const foot = w.addStack();
  foot.centerAlignContent();
  const left = foot.addText(`${thisWeek} this week`);
  left.font = Font.semiboldSystemFont(11);
  left.textColor = C.label2;
  foot.addSpacer();
  const last = workouts[0];
  const lastPr = workouts.find((x) => x.prs > 0);
  // Stale if the newest file is older than 4 days: the next day may be out of date.
  if (Date.now() - (data.updated || 0) > 4 * 864e5) {
    const r = foot.addText('Open to refresh');
    r.font = Font.semiboldSystemFont(10);
    r.textColor = C.orange;
  } else if (lastPr && last && lastPr.date === last.date) {
    const sym = SFSymbol.named('star.fill');
    const img = foot.addImage(sym.image);
    img.imageSize = new Size(10, 10);
    img.tintColor = C.orange;
    foot.addSpacer(3);
    const pr = foot.addText(`${lastPr.prs} PR`);
    pr.font = Font.semiboldSystemFont(11);
    pr.textColor = C.orange;
  }
  return w;
}

const data = await loadData();
const widget = data ? buildWidget(data) : emptyWidget();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();
Script.complete();
