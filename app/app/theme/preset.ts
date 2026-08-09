/**
 * The staff app's theme.
 *
 * The palette itself lives in `@francis/theme`, because there are two apps now and
 * "colour lives in exactly two files" stops being true the moment a second one copies
 * them — the same drift that gave one input class four different paddings.
 *
 * This app takes the dark scheme and is pinned to it: the shop tablet must not flip to
 * light because somebody changed an iPad setting.
 */

export { francisDarkPreset as francisPreset } from '@francis/theme';
