# Orbitry (MVP)

This is the very first **Orbitry editor** skeleton.

Orbitry goal (mass-market): a "Marzipano Tool, but human" workflow:
- **Local-first** editing
- **Project file** you own
- **Export** a standalone tour you can host anywhere

## What works in this MVP
- Import one or more 360 **equirectangular** images (2:1)
- Browse scenes
- View the panorama via **Marzipano**
- Click in the panorama to add **info hotspots**
- Save/load the **Orbitry project** JSON (assets are **not embedded yet**)

## Development

### Prerequisites
- Node.js 20+ recommended

### Run locally
```bash
npm install
npm run dev
```

### Build
```bash
npm run build
```

## Notes
- Current project format: `orbitry.project.json` (version `1`).
- In this MVP, panoramas are kept as local files (object URLs). When you load a project JSON, you may need to re-import panoramas (assets embedding comes next).

## Next steps
- Link hotspots
- Import Marzipano Tool exports (`APP_DATA`)
- Export a standalone web bundle (fast export: single equirect; optimized export: cube tiles)
- Theme editor (buttons/hotspots/UI presets)
