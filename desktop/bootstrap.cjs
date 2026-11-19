const { app, dialog } = require("electron");

import("./main.ts").catch((error) => {
  console.error(error);
  if (app.isPackaged && !process.argv.some((argument) => argument.startsWith("--check-"))) {
    dialog.showErrorBox("Stillwater could not start", error.message || String(error));
  }
  app.exit(1);
});
