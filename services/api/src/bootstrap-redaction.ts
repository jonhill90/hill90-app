/**
 * Side-effect module: install log redaction before anything else can log.
 *
 * It exists as its own module because `import` statements are HOISTED. Calling
 * installConsoleRedaction() between imports in index.ts looks like it runs
 * first and does not — every other module is evaluated before that statement.
 * Import order between side-effectful modules IS preserved, so importing this
 * first is the version that actually works.
 */
import axios from 'axios';
import { installConsoleRedaction, installAxiosRedaction } from './helpers/redact';

installConsoleRedaction();
installAxiosRedaction(axios);
