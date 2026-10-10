The impeccable finish review returned "fix" with these material fixes. Apply all of them in one batch inside src/ui/*.tsx and src/assets/app.css, keep every data-testid, status sentence and native input, then rerun the AGENTS.md checks and the detector on the changed files, update plan/evidence/D7-return.md, and stop. The lead recaptures the screenshots and sends them back for the verdict.

1. Object node heading (src/ui/app.tsx line 64). The scope heading stays "Scene" (the sliders edit the whole scene; the lead corrected the contract to say so). The Object node's h3 doubles the word Object: make it the object's name only (for example "Object 1"), keep section.object-node[aria-label="Object"] and the swatches test id. Check no scenario matches the "Object ·" text.

2. The Fry row as the dial (src/assets/app.css). Within the native range, give .node[aria-label="Fry"] .range-row the dial's weight: an 8 px track, a 20 px thumb, the value in var(--text) at var(--type-ui), and the input spanning the label column; visually hide the row's "Fry" label with .visually-hidden while keeping label[for="style-fry"], the id and the data-testid so the accessible name and the scenarios hold. No new control, no dial widget.

3. The Plate row's selected state (src/ui/layers.tsx, src/assets/app.css). When scene.selected is null the Plate row is the scope and must show it: add is-selected to the Plate row in that state, or style .layer-row[aria-pressed="true"] identically to .is-selected. Today ready-1440.png shows no row selected while the inspector edits the scene.

4. The layer hint (src/ui/layers.tsx line 33). Show "Tap the picture to add a layer" only when scene !== null && scene.doc.objects.length === 0; with no photo open it instructs an action that does not exist.

5. Model count: "3 models local" is true today (depth, SAM 2.1, MI-GAN) and stays; the lead corrected the contract. No change.

6. One authored transition (src/assets/app.css): 120 to 160 ms ease-out on .enable-switch input::before (transform), .disclosure-icon (transform) and .enable-switch input (background-color, border-color); nothing on the stage or the sliders; under @media (prefers-reduced-motion: reduce) set those durations to 0.

Keep the restraint the reviewer named: flat panels on the ground, hairlines only, the pink only on Download, the thumbs, selection and focus; no card, shadow, second accent or decorative gradient.
