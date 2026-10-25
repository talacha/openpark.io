// Shim for Node.js modules that aren't available in service workers
// These are only imported during the build process for the manifest generation

// These are dummy exports - the actual sw-entry.ts runs in browser
export const crypto = {
  subtle: {
    digest: async (algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> => {
      throw new Error('Not available in browser context during build');
    },
  },
};
export const fs = {};
export const path = {};
export const url = {};
export const stream = {};
