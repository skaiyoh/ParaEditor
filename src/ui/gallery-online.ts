// The hosted gallery is offline until owner access exists, so only a dev build,
// whose dev server keeps its own gallery, offers publishing and the gallery page.
// A production build hides Publish and shows the gallery as offline, and makes no
// gallery request. docs/ARCHITECTURE.md ("Hosted store and gallery") owns the contract.
export const GALLERY_ONLINE: boolean = NOISY_DEV;
