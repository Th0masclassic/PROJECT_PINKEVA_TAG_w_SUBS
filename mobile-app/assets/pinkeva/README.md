# Pinkeva raster assets

These are deterministic crops of the approved flattened mockups. Reuse these
files everywhere instead of cropping a mockup again. The UI uses the transparent
variants so that the same approved device artwork remains consistent on every screen.

| Asset | Source | Crop `(x, y, width, height)` |
| --- | --- | --- |
| `card.png` | `Tracker_clickedTracker.png` | `(208, 248, 536, 396)` |
| `keys.png` | `TrackerSection_withTags.png` | `(82, 622, 218, 196)` |
| `backpack.png` | `TrackerSection_withTags.png` | `(78, 884, 218, 208)` |
| `avatar.png` | `SettingsImage.png` | `(77, 316, 142, 142)` |
| `map.png` | `mapSection.png` | `(0, 208, 853, 900)` |

`card-transparent.png`, `keys-transparent.png`, and `backpack-transparent.png`
are soft-matted versions of those exact crops with only the screenshot background
removed. `google.png` is the approved Google mark cropped from the login mockup.

`brand-mark.png` is the Pinkeva P cropped at `(235, 149, 112, 150)` from the
supplied 900 × 1600 login mockup. The standard Expo icon files are deterministic
compositions of that mark. The car choice is rendered from one canonical code-native
vector icon, so all of its appearances also remain identical.
