// Host-bucket sentinels shared by the main-process mirror and the renderer's
// mirror store. Kept in a tiny module both sides can import without dragging
// the whole mirror (or any renderer code) into unrelated builds.

/** Sentinel meaning "show activity for every host bucket". */
export const ALL_HOSTS = '__all__';

/**
 * exec_multi aggregates carry no single hostId - attribute them to this
 * synthetic bucket so they still appear in the ALL_HOSTS view.
 */
export const MULTI_HOST_BUCKET = '__multi__';
