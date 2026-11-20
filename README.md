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

## Home screen widget (Scriptable)

`widget/LiftTracker.js` is a small, square widget for the [Scriptable](https://scriptable.app) app. It shows the next day in your rotation, the rep target, this week's workouts and a PR star.

1. In Scriptable, tap **+**, paste the script and name it "Lift Tracker".
2. In Lifts, tap **Program › Update Home Screen Widget…**, then **Save to Files › iCloud Drive › Scriptable** (choose **Replace** if asked). The workout summary has the same link.
3. Add a small Scriptable widget to the home screen, tap it while editing and choose the "Lift Tracker" script.

Repeat step 2 after a workout to refresh it. Tapping the widget opens the app.
