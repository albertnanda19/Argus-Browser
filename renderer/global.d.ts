import type { SidecarState } from "../shared/contracts";

declare global {
  interface Window {
    argus: {
      getSidecarState: () => Promise<SidecarState>;
      restartSidecar: () => Promise<void>;
    };
  }
}

export {};
