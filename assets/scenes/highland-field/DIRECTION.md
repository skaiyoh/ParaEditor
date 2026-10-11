# Highland field viewer direction

> Owns: this standalone scene viewer's presentation and evidence contract.
> Does not own: the application's design system, renderer, or status.

Mode: Experience.
This is a narrow scene preview inside Noisy's established visual world, built directly from the user's specified landscape and interaction.
It introduces no application design-system changes.

The first viewport is a real perspective window into a quiet alpine meadow.
Weathered foreground stones overlap a broad grass field; several mountain ridges carry distance, atmospheric haze, and pale snow.
The interface inherits Noisy's dark neutral fills, near-white text, thin borders, eight-pixel control corners, and 44-pixel touch targets.
One quiet title and a compact control row leave the landscape in charge.
Use system sans for these inherited utility controls.

The signature interaction is a fixed aperture with an off-axis projection.
Moving the eye translates the viewpoint without turning the window plane.
The monitor edges define the aperture; there is no visible box around the actual view.
The 2.8-unit-deep wall is retained only as a hidden Blender construction reference, following Nathan's correction after seeing the live preview.
The grass, cairn, near boulder, and mountain layers change overlap, and actual hidden objects become visible.
Head tracking uses the existing local UltraFace worker, explicit camera permission, neutral calibration, and an adjustable gain of 2.0 by default.
Nathan tried the live scene after frame removal and motion smoothing and explicitly approved the appearance and 2x head gain.
The authored eye envelope is 3.6 units sideways and 1.4 vertically at a fixed eight-unit viewing distance.
Pointer movement, touch dragging, and arrows provide immediate access.
Tilt requires a deliberate user action and calibration; automatic movement is optional and starts off.
The camera uses a critically damped spring to interpolate the 15 Hz detector at the display rate.
Reduced-motion users get immediate input without inertia.

Required evidence: desktop 1440 x 1000, landscape tablet 1180 x 820, portrait 390 x 844, extreme left/right/up/down views, and actual occlusion measurements.
Review source still and native Blender views separately from browser captures.
Quality bar: preserve the approved landscape and 2x gain, legible understated controls, stable screen-plane perspective, real disocclusion, no uncovered edges or placeholder imagery, accessible input and actionable rendering errors.
The standalone renderer and native Blender render may use different lighting approximations; provenance must say so.
