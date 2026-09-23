# Tilt Water

A 2D water simulation for phones. Tilt the phone and the water flows downhill; touch the screen to stir it.

- **Physics**: ~500–1600 particles, position-based SPH ("double density relaxation", Clavet et al. 2005) with pairwise viscosity, fixed 240 Hz time step (`fluid.js`).
- **Input**: `deviceorientation` (beta/gamma) converted to a gravity vector, compensated for portrait/landscape screen rotation. When the browser rotates, the water rotates with the phone.
- **Rendering**: WebGL metaballs (density splat + threshold/shading pass), with a Canvas 2D fallback.
- **Desktop**: no tilt sensor, so the arrow keys / WASD tilt, the mouse stirs, and `R` resets.

## Running it on your phone

Browsers only expose tilt sensors to pages served over **HTTPS**, so opening the file directly won't work. The easiest route is GitHub Pages:

1. In the repo on GitHub go to **Settings → Pages**, set *Source* to **Deploy from a branch**, and pick `main` and the `/ (root)` folder.
2. Open `https://danielyaple17-ui.github.io/water/` on your phone and tap **Start**.

On iPhone, Safari will ask for permission to use motion and orientation. Tap **Allow**. If you deny it by accident, close the tab and reopen the page.

On Android the page goes fullscreen and locks to portrait so the screen doesn't flip while you tilt. You can also add it to your home screen to run it like an app.

## Local development

No build step. Serve the folder with any static server, e.g. `npx http-server .`, and open it in a desktop browser.
