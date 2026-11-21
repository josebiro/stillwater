const { contextBridge, ipcRenderer } = require("electron");

// The alert card can only receive what to show and send back the name of the button pressed.
contextBridge.exposeInMainWorld("meetingAlert", {
  onShow: (callback) => ipcRenderer.on("alert:show", (_event, alert) => callback(alert)),
  act: (action) => ipcRenderer.send("alert:act", action),
  resize: (height) => ipcRenderer.send("alert:resize", height),
});
