// SPDX-License-Identifier: MIT
// Runs inside the converter's background worker. Adapted from the zetajs PDF conversion example.

import { ZetaHelperThread } from './vendor/zetajs/zetaHelper.js';

const zHT = new ZetaHelperThread();
const zetajs = zHT.zetajs;
const css = zHT.css;

let xModel;

function start() {
  const beanHidden = new css.beans.PropertyValue({ Name: 'Hidden', Value: true });
  const beanOverwrite = new css.beans.PropertyValue({ Name: 'Overwrite', Value: true });
  const beanPdf = new css.beans.PropertyValue({ Name: 'FilterName', Value: 'writer_pdf_Export' });

  zHT.thrPort.onmessage = (e) => {
    if (e.data.cmd !== 'convert') throw Error('Unknown message command: ' + e.data.cmd);
    const { id, name, from, to } = e.data;
    try {
      // Close the previous document before opening the next one. A failed open leaves nothing behind.
      const previous = xModel;
      xModel = undefined;
      if (previous && previous.queryInterface(zetajs.type.interface(css.util.XCloseable))) {
        previous.close(false);
      }
      const opened = zHT.desktop.loadComponentFromURL('file://' + from, '_blank', 0, [beanHidden]);
      if (!opened) throw Error('The file could not be opened.');
      xModel = opened;
      xModel.storeToURL('file://' + to, [beanOverwrite, beanPdf]);
      zetajs.mainPort.postMessage({ cmd: 'converted', id, name, from, to });
    } catch (err) {
      let message = 'The file could not be converted.';
      try {
        const exc = zetajs.catchUnoException(err);
        if (exc && exc.Message) message = exc.Message;
      } catch (_) {
        if (err && err.message) message = err.message;
      }
      zetajs.mainPort.postMessage({ cmd: 'failed', id, name, from, to, message });
    }
  };

  zHT.thrPort.postMessage({ cmd: 'start' });
}

start();
