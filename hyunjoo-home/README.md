# Hyunjoo's Home Page

Edit these files to change the site:

- `index.html` — words and page structure
- `style.css` — colors, fonts, layout, and animation
- `script.js` — button behavior
- `assets/` — optional images and GIFs

From this folder, run `npm run dev` and open the local URL printed in the terminal. The same command also works from the parent `hyunjoo's homepage` folder. Refresh the browser after saving a change.

Run `npm run build` to copy the editable source into `dist/` for publishing. Avoid editing `dist/` directly because each build replaces it.

The first Interactive project is published from `projects/bodyTracking/`. To refresh it after editing the sibling `bodyTracking` project, run `npm run build -- --base ./` there, then copy the contents of its `dist/` folder into `hyunjoo-home/projects/bodyTracking/` and rebuild this site.
