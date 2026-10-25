import { contextBridge, ipcRenderer } from "electron";
import type { ApiInfo } from "../shared/contracts";

contextBridge.exposeInMainWorld("argus", {
  getApiInfo: (): Promise<ApiInfo | null> => ipcRenderer.invoke("api:get-info"),
});
