# Orbitry Project Format v1

File: `orbitry.project.json`

## Top-level
```json
{
  "version": 1,
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "title": "My tour",
  "scenes": [ ... ]
}
```

## Scene
Each scene is a single panorama + hotspots.

Fields:
- `id` (string)
- `name` (string)
- `panorama.type` = `"equirect"` (MVP)
- `initialView` = `{ yaw, pitch, fov }`
- `hotspots[]` = link/info

## Hotspot
- `type: "info"` -> `{ yaw, pitch, title?, text? }`
- `type: "link"` -> `{ yaw, pitch, targetSceneId }`

## Notes
In MVP, panoramas are not embedded into the project file. Later we will support:
- embedding assets into an export ZIP
- or a companion folder structure
