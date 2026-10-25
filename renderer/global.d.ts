import type { ApiInfo } from "../shared/contracts";

declare global {
  interface Window {
    argus: {
      getApiInfo: () => Promise<ApiInfo | null>;
    };
  }
}

export {};
