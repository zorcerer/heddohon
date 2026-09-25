/**
 * The release, from `package.json`.
 *
 * A named import, so the build carries this one field and not the file: the
 * rest of it is the dependency list, and the value reaches the browser.
 * Read on the server and handed to pages as data for the same reason.
 */
import { version } from '../../../package.json';

export const APP_VERSION: string = version;
