// The ordered registry of hb_* tools exposed by the server.

import type { HbTool } from './index.js';
import { hbConnect, hbDisconnect, hbSessionInfo } from './connect.js';
import { hbPageStatus, hbPageHandle } from './page.js';
import { hbClassifyPage } from './classify.js';
import { hbProfileDelete, hbProfilesList, hbRecordingDelete, hbRecordingsList, hbRecordingUrl, hbSessionsList, hbSessionStop } from './dashboard.js';
import { hbReference } from './reference.js';

export const HB_TOOLS: HbTool[] = [
  hbConnect,
  hbDisconnect,
  hbSessionInfo,
  hbClassifyPage,
  hbPageHandle,
  hbPageStatus,
  hbSessionsList,
  hbSessionStop,
  hbRecordingsList,
  hbRecordingUrl,
  hbRecordingDelete,
  hbProfilesList,
  hbProfileDelete,
  hbReference,
];
