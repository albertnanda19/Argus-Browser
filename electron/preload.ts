import { contextBridge, ipcRenderer } from "electron";
import type { SidecarState } from "../shared/contracts";

contextBridge.exposeInMainWorld("argus", {
  getSidecarState: (): Promise<SidecarState> => ipcRenderer.invoke("api:get-state"),
  restartSidecar: (): Promise<void> => ipcRenderer.invoke("api:restart"),
});
