# Lift Tracker

A personal workout logger built as an installable iPhone web app (PWA).

- Pick 5-7 exercises from a day (Back, Leg, Shoulder, Chest, Arm), log weight and reps per set.
- Each exercise is prefilled from last time, with a +5 lb hint once every set hits the top of the rep range.
- Rest timer, PR alerts, plate math, notes, progress charts and an editable history.
- Works offline. Data stays on the phone; use Program → Save Backup to export it.

## Install on iPhone

Open the GitHub Pages link in Safari, tap Share, then **Add to Home Screen**.

## Develop

Plain HTML, CSS and JavaScript with no build step. Serve the folder with any static server, for example `python3 -m http.server`.
When you change a file, bump `VERSION` in `sw.js` so installed copies pick up the update.
